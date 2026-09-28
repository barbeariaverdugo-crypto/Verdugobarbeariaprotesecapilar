import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { setOwner } from '../server/auth.js';
import { importPlanilha } from '../scripts/importar-planilha.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EMAIL = 'dono@verdugo.test';
export const SENHA = 'SenhaForte2026';

/**
 * Banco dos testes: Postgres em memória (PGlite). Com TEST_PG_URL (ex.: postgres://postgres:senha@localhost:5432/postgres),
 * cria um banco novo nesse servidor Postgres de verdade — testa o mesmo driver usado com o Supabase.
 */
export async function testDatabaseUrl() {
  const base = process.env.TEST_PG_URL;
  if (!base) return 'memory:';
  const pg = (await import('pg')).default;
  const name = `verdugo_teste_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const c = new pg.Client({ connectionString: base });
  await c.connect(); await c.query(`CREATE DATABASE ${name}`); await c.end();
  const u = new URL(base); u.pathname = `/${name}`;
  return u.toString();
}

/** Sobe o app num banco temporário (com os dados da planilha importados) e devolve um cliente já logado. */
export async function startApp({ importar = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verdugo-test-'));
  const app = createApp({ databaseUrl: await testDatabaseUrl(), uploadsDir: join(dir, 'comprovantes') });
  const db = app.locals.db;
  setOwner(db, EMAIL, SENHA);
  let importRep = null;
  if (importar) importRep = importPlanilha(db, JSON.parse(readFileSync(join(root, 'dados', 'planilha_extraida.json'), 'utf8')));
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const anon = client(base, null);
  const login = await anon.post('/api/login', { email: EMAIL, senha: SENHA });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { app, db, server, base, api: client(base, cookie), anon, importRep, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}

export function client(base, cookie) {
  const call = async (method, path, body) => {
    const headers = { 'x-verdugo': '1' };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b = {}) => call('PUT', p, b),
  };
}

export const ids = (db) => ({
  barber: (n) => db.prepare('SELECT id FROM barbers WHERE name=?').get(n).id,
  service: (n) => db.prepare('SELECT id FROM services WHERE name=?').get(n).id,
  product: (sku) => db.prepare('SELECT id FROM products WHERE sku=?').get(sku).id,
  saldo: (sku) => db.prepare('SELECT COALESCE(SUM(m.qty),0) s FROM stock_movements m JOIN products p ON p.id=m.product_id WHERE p.sku=?').get(sku).s,
});
