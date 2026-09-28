import express from 'express';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { login, logout, requireApiAuth, requirePageAuth, sessionFromReq } from './auth.js';
import { errorHandler } from './http.js';
import { seedDefaults } from './seed.js';
import cadastros from './routes/cadastros.js';
import atendimentos from './routes/atendimentos.js';
import balcao from './routes/balcao.js';
import online from './routes/online.js';
import estoque from './routes/estoque.js';
import financeiro from './routes/financeiro.js';
import exportar from './routes/exportar.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'public');

export function createApp({ dbFile, uploadsDir, db: givenDb } = {}) {
  const db = givenDb ?? openDb(dbFile);
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
  app.get('/login', (req, res) => (sessionFromReq(db, req) ? res.redirect('/') : res.sendFile(join(PUBLIC, 'login.html'))));
  app.get('/login.js', pub('login.js'));
  app.get('/estilo.css', pub('estilo.css'));
  app.use('/img', express.static(join(PUBLIC, 'img'), { maxAge: '7d' }));
  app.post('/api/login', (req, res, next) => { try { login(db, req, res); } catch (e) { next(e); } });
  app.post('/api/logout', (req, res) => logout(db, req, res));
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
  api.use(financeiro(db, { uploadsDir: resolve(uploadsDir ?? join(dirname(resolve(dbFile ?? 'dados/verdugo.db')), 'comprovantes')) }));
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

// Execução direta: npm start
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbFile = process.env.DB_FILE || join(here, '..', 'dados', 'verdugo.db');
  const app = createApp({ dbFile, uploadsDir: process.env.UPLOADS_DIR });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const owner = app.locals.db.prepare('SELECT email FROM owner WHERE id=1').get();
  app.listen(port, host, () => {
    console.log(`Verdugo rodando em http://${host}:${port}`);
    console.log(`Banco de dados: ${dbFile}`);
    if (!owner) console.log('ATENÇÃO: nenhuma conta criada ainda. Rode:  npm run definir-senha');
  });
}
