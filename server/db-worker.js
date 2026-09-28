// Roda em uma thread separada e é quem de fato conversa com o Postgres (Supabase) e com o Storage.
// A thread principal manda um pedido e espera a resposta (ver db.js). Assim o resto do app continua
// escrevendo "db.prepare(sql).get(...)" de forma direta, como fazia com o SQLite, e cada requisição
// é atendida por inteiro antes da próxima — as transações ficam isoladas do mesmo jeito que antes.
import { workerData } from 'node:worker_threads';

const { url, sab, port, storage } = workerData;
const flag = new Int32Array(sab);

const MEMORY = !url || url.startsWith('memory:') || url.startsWith('pglite:');
let conn = null; // { query(sql, params), exec(sql), close() }
let inTx = false;

async function connectPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const db = new PGlite({ extensions: { citext }, parsers: { 20: Number, 1700: Number } });
  await db.waitReady;
  return {
    query: async (sql, params) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rowCount ?? 0 }; },
    exec: async (sql) => { await db.exec(sql); },
    close: () => db.close(),
  };
}

async function connectPg() {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, Number);   // bigint (SUM, COUNT) → número
  pg.types.setTypeParser(1700, Number); // numeric → número
  // o Supabase usa certificado próprio; a conexão continua criptografada (TLS)
  const clean = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const client = new pg.Client({
    connectionString: clean,
    ssl: local ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    statement_timeout: 20000,
    query_timeout: 25000,
    application_name: 'verdugo-app',
  });
  client.on('error', () => { if (conn?.client === client) conn = null; });
  await client.connect();
  return {
    client,
    query: async (sql, params) => { const r = await client.query(sql, params); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; },
    exec: async (sql) => { await client.query(sql); },
    close: () => client.end(),
  };
}

async function getConn() {
  if (!conn) conn = MEMORY ? await connectPglite() : await connectPg();
  return conn;
}

const isConnError = (e) => !e?.code || /^(08|57P0)/.test(e.code) || /ECONNRESET|EPIPE|ETIMEDOUT|terminated|Connection/i.test(e.message || '');

async function runSql({ op, sql, params }) {
  const trimmed = sql.trim().toUpperCase();
  for (let attempt = 0; ; attempt++) {
    const c = await getConn();
    try {
      let out;
      if (op === 'exec') { await c.exec(sql); out = { rows: [], rowCount: 0 }; }
      else out = await c.query(sql, params);
      if (trimmed.startsWith('BEGIN')) inTx = true;
      else if (trimmed.startsWith('COMMIT') || trimmed.startsWith('ROLLBACK') && !trimmed.startsWith('ROLLBACK TO')) inTx = false;
      return out;
    } catch (e) {
      // conexão caiu (a Vercel "congela" a função entre requisições): reconecta e tenta de novo, fora de transação
      if (!MEMORY && attempt === 0 && !inTx && isConnError(e)) { try { await c.close(); } catch { /* já caiu */ } conn = null; continue; }
      if (trimmed.startsWith('ROLLBACK')) inTx = false;
      throw e;
    }
  }
}

// ---------- Supabase Storage (comprovantes) ----------
const sto = storage || {};
const stoHeaders = (extra = {}) => ({ Authorization: `Bearer ${sto.key}`, apikey: sto.key, ...extra });
const objUrl = (name) => `${sto.url}/storage/v1/object/${sto.bucket}/${encodeURIComponent(name)}`;

async function ensureBucket() {
  const r = await fetch(`${sto.url}/storage/v1/bucket`, {
    method: 'POST', headers: stoHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: sto.bucket, name: sto.bucket, public: false }),
  });
  if (!r.ok && r.status !== 409) {
    const t = await r.text();
    if (!/already exists|Duplicate/i.test(t)) throw new Error(`Não consegui criar o bucket de comprovantes: ${r.status} ${t}`);
  }
}

async function storagePut({ name, data, type }) {
  const send = () => fetch(objUrl(name), { method: 'POST', headers: stoHeaders({ 'Content-Type': type, 'x-upsert': 'false' }), body: Buffer.from(data, 'base64') });
  let r = await send();
  if (!r.ok) {
    const t = await r.text();
    if (/bucket not found|not found/i.test(t) || r.status === 404) { await ensureBucket(); r = await send(); if (!r.ok) throw new Error(`Falha ao guardar comprovante: ${r.status} ${await r.text()}`); }
    else throw new Error(`Falha ao guardar comprovante: ${r.status} ${t}`);
  }
  return { ok: true };
}

async function storageGet({ name }) {
  const r = await fetch(objUrl(name), { headers: stoHeaders() });
  if (r.status === 404 || r.status === 400) return { found: false };
  if (!r.ok) throw new Error(`Falha ao ler comprovante: ${r.status}`);
  return { found: true, data: Buffer.from(await r.arrayBuffer()).toString('base64'), type: r.headers.get('content-type') };
}

port.on('message', async (msg) => {
  let reply;
  try {
    let result;
    if (msg.op === 'query' || msg.op === 'exec') result = await runSql(msg);
    else if (msg.op === 'storage_put') result = await storagePut(msg);
    else if (msg.op === 'storage_get') result = await storageGet(msg);
    else if (msg.op === 'close') { if (conn) await conn.close(); conn = null; result = { ok: true }; }
    else throw new Error(`operação desconhecida: ${msg.op}`);
    reply = { ok: true, result };
  } catch (e) {
    reply = { ok: false, error: { message: e?.message || String(e), code: e?.code, detail: e?.detail, constraint: e?.constraint } };
  }
  port.postMessage({ ...reply, id: msg.id });
  Atomics.store(flag, 0, msg.id);
  Atomics.notify(flag, 0);
});
