import express from 'express';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { login, logout, requireApiAuth, requirePageAuth, sessionFromReq } from './auth.js';
import { errorHandler } from './http.js';
import { seedDefaults } from './seed.js';
import { setupHandler, hasOwner } from './setup.js';
import cadastros from './routes/cadastros.js';
import atendimentos from './routes/atendimentos.js';
import balcao from './routes/balcao.js';
import online from './routes/online.js';
import estoque from './routes/estoque.js';
import financeiro from './routes/financeiro.js';
import exportar from './routes/exportar.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'public');

export function createApp({ databaseUrl, uploadsDir, db: givenDb } = {}) {
  const db = givenDb ?? openDb(databaseUrl ?? process.env.DATABASE_URL ?? 'memory:');
  seedDefaults(db);
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : process.env.TRUST_PROXY);

  // Cabeçalhos de segurança
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '6mb' }));

  // --- Público: só a tela de login e seus arquivos ---
  const pub = (file) => (req, res) => res.sendFile(join(PUBLIC, file));
  app.get('/login', (req, res) => (sessionFromReq(db, req) ? res.redirect('/')
    : !hasOwner(db) ? res.redirect('/configurar') : res.sendFile(join(PUBLIC, 'login.html'))));
  app.get('/login.js', pub('login.js'));
  app.get('/estilo.css', pub('estilo.css'));
  app.use('/img', express.static(join(PUBLIC, 'img'), { maxAge: '7d' }));
  app.post('/api/login', (req, res, next) => { try { login(db, req, res); } catch (e) { next(e); } });
  app.post('/api/logout', (req, res) => logout(db, req, res));
  // primeira configuração (só enquanto não existe a conta do proprietário)
  app.get('/configurar', (req, res) => (hasOwner(db) ? res.redirect('/login') : res.sendFile(join(PUBLIC, 'configurar.html'))));
  app.get('/configurar.js', pub('configurar.js'));
  app.post('/api/configurar', (req, res, next) => {
    if (req.headers['x-verdugo'] !== '1') return res.status(403).json({ erro: 'Requisição recusada.' });
    try { setupHandler(db)(req, res); } catch (e) { next(e); }
  });
  app.get('/saude', (req, res) => res.json({ ok: true }));

  // --- Tudo daqui para baixo exige a sessão do proprietário ---
  const api = express.Router();
  api.use(requireApiAuth(db));
  api.get('/sessao', (req, res) => res.json({ ok: true, email: db.prepare('SELECT email FROM owner WHERE id=1').get()?.email }));
  api.use(cadastros(db));
  api.use(atendimentos(db));
  api.use(balcao(db));
  api.use(online(db));
  api.use(estoque(db));
  // Comprovantes: Supabase Storage (se configurado) → senão, no próprio banco quando publicado (a Vercel não guarda arquivos)
  // → senão, numa pasta local (uso no computador / testes).
  const receiptsInDb = !db.remoteStorage && (process.env.RECEIPTS_IN_DB === '1' || (!!process.env.VERCEL && process.env.RECEIPTS_IN_DB !== '0'));
  api.use(financeiro(db, { receiptsInDb, uploadsDir: resolve(uploadsDir ?? process.env.UPLOADS_DIR ?? join(here, '..', 'dados', 'comprovantes')) }));
  api.use(exportar(db));
  api.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
  app.use('/api', api);

  const page = requirePageAuth(db);
  app.get('/app.js', page, pub('app.js'));
  app.get(['/', '/index.html'], page, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(PUBLIC, 'app.html'));
  });
  app.use((req, res) => res.status(404).send('Página não encontrada.'));
  app.use(errorHandler);
  app.locals.db = db;
  return app;
}

// Execução direta: npm start (no computador). Sem DATABASE_URL, usa um banco em memória só para testar.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL || 'memory:';
  const app = createApp({ databaseUrl });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const owner = app.locals.db.prepare('SELECT email FROM owner WHERE id=1').get();
  app.listen(port, host, () => {
    console.log(`Verdugo rodando em http://${host}:${port}`);
    console.log(databaseUrl.startsWith('memory:') ? 'ATENÇÃO: banco em memória (nada fica salvo). Defina DATABASE_URL para usar o Supabase.' : 'Banco: Supabase (DATABASE_URL)');
    if (!owner) console.log(`Nenhuma conta criada ainda: abra http://${host}:${port}/configurar ou rode  npm run definir-senha`);
  });
}
