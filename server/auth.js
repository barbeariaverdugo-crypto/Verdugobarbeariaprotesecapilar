import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { nowIso, one } from './db.js';

const COOKIE = 'vd_sess';
const SESSION_DAYS = 14;
const MAX_FAILS = 5;            // tentativas erradas por IP...
const WINDOW_MIN = 15;          // ...a cada 15 minutos

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(keyHex, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
}

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letras e números na senha.';
  return null;
}

export function setOwner(db, email, password) {
  const err = validatePasswordStrength(password);
  if (err) throw new Error(err);
  const now = nowIso();
  db.prepare(`INSERT INTO owner(id, email, pass_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET email = excluded.email, pass_hash = excluded.pass_hash, updated_at = excluded.updated_at`)
    .run(String(email).trim().toLowerCase(), hashPassword(password), now, now);
  db.prepare('DELETE FROM sessions').run(); // troca de senha derruba todas as sessões
}

const sha = (t) => createHash('sha256').update(t).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie malformado de outro site: ignora */ }
  }
  return out;
}

function cookieAttrs(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function sessionFromReq(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = one(db, 'SELECT * FROM sessions WHERE id = ?', sha(token));
  if (!s) return null;
  if (s.expires_at < nowIso()) { db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id); return null; }
  return s;
}

function tooManyFails(db, ip) {
  const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
  const r = one(db, 'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND at > ?', ip, since);
  return r.n >= MAX_FAILS;
}

export function login(db, req, res) {
  const ip = req.ip || 'desconhecido';
  if (tooManyFails(db, ip)) {
    return res.status(429).json({ erro: `Muitas tentativas. Aguarde ${WINDOW_MIN} minutos e tente de novo.` });
  }
  const { email, senha } = req.body || {};
  const owner = one(db, 'SELECT * FROM owner WHERE id = 1');
  const ok = !!owner && typeof senha === 'string' &&
    String(email || '').trim().toLowerCase() === owner.email && verifyPassword(senha, owner.pass_hash);
  db.prepare('INSERT INTO login_attempts(ip, at, ok) VALUES (?, ?, ?)').run(ip, nowIso(), ok ? 1 : 0);
  if (!ok) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  const token = randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?)')
    .run(sha(token), nowIso(), exp, ip, String(req.headers['user-agent'] || '').slice(0, 200));
  db.prepare("DELETE FROM login_attempts WHERE at < ?").run(new Date(Date.now() - 86400000).toISOString());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(req)}; Max-Age=${SESSION_DAYS * 86400}`);
  res.json({ ok: true });
}

export function logout(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
  res.json({ ok: true });
}

/** Protege as rotas da API: sem sessão válida, 401. Ações que alteram dados exigem cabeçalho próprio (anti-CSRF). */
export function requireApiAuth(db) {
  return (req, res, next) => {
    const s = sessionFromReq(db, req);
    if (!s) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-verdugo'] !== '1')
      return res.status(403).json({ erro: 'Requisição recusada.' });
    req.session = s;
    next();
  };
}

/** Protege as páginas: sem sessão, redireciona para /login. */
export function requirePageAuth(db) {
  return (req, res, next) => {
    if (!sessionFromReq(db, req)) return res.redirect(302, '/login');
    next();
  };
}
