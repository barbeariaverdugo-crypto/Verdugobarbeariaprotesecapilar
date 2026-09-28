// Banco de dados: Postgres (Supabase em produção; PGlite em memória nos testes e para testar localmente).
// A conversa com o banco acontece numa thread à parte (db-worker.js); aqui a chamada espera a resposta,
// então o restante do código segue síncrono, exatamente como era com o SQLite.
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS || 30000);

export const DEFAULT_SETTINGS = {
  commission_pct_default: '0.5',     // 50%, igual à planilha
  commission_base: 'tabela',         // 'tabela' = sobre o preço dos serviços (como na planilha) | 'apos_desconto'
  return_restock_default: '1',       // devolução online volta ao estoque por padrão
  low_stock_alert: '1',
};

export class DbError extends Error {
  constructor(e) { super(e.message); this.code = e.code; this.detail = e.detail; this.constraint = e.constraint; }
}

/** Converte o SQL no estilo SQLite usado no app ("?" etc.) para Postgres. */
const cache = new Map();
export function toPg(sql) {
  let out = cache.get(sql);
  if (out) return out;
  let s = sql;
  if (/^\s*BEGIN IMMEDIATE/i.test(s)) s = 'BEGIN';
  s = s.replace(/\s+COLLATE\s+NOCASE/gi, ''); // colunas de nome/SKU são CITEXT (sem diferença de maiúscula)
  let ignore = false;
  s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, () => { ignore = true; return 'INSERT INTO'; });
  if (ignore) s = `${s.trimEnd()} ON CONFLICT DO NOTHING`;
  // "?" → $1, $2... (fora de textos entre aspas); "? IS NULL" precisa de tipo explícito no Postgres
  let n = 0; let res = ''; let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { res += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; res += ch; continue; }
    if (ch === '?') {
      n++;
      res += /^\s+IS\s+(NOT\s+)?NULL/i.test(s.slice(i + 1)) ? `$${n}::text` : `$${n}`;
      continue;
    }
    res += ch;
  }
  out = { sql: res, isInsert: /^\s*INSERT\s/i.test(res) && !/\bRETURNING\b/i.test(res) };
  cache.set(sql, out);
  return out;
}

const fixParam = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v);

class Statement {
  constructor(db, sql) { this.db = db; this.src = sql; }
  get(...p) { return this.db._query(this.src, p).rows[0]; }
  all(...p) { return this.db._query(this.src, p).rows; }
  run(...p) {
    const t = toPg(this.src);
    const r = this.db._raw('query', t.isInsert ? `${t.sql} RETURNING *` : t.sql, p.map(fixParam));
    return { changes: r.rowCount, lastInsertRowid: r.rows?.[0]?.id };
  }
}

export class Database {
  constructor(url, { storage } = {}) {
    this.url = url;
    this.sab = new SharedArrayBuffer(4);
    this.flag = new Int32Array(this.sab);
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(join(here, 'db-worker.js'), {
      workerData: { url, sab: this.sab, port: port2, storage: storage ?? null },
      transferList: [port2],
      execArgv: [], // não herda opções de linha de comando do processo principal
    });
    this.worker.unref();
    this.remoteStorage = !!storage;
  }

  _call(msg) {
    // cada pedido leva um número; respostas atrasadas de pedidos anteriores (após timeout) são descartadas
    const id = (this.seq = ((this.seq ?? 0) % 2000000000) + 1);
    this.port.postMessage({ ...msg, id });
    const deadline = Date.now() + (this.timeoutMs ?? TIMEOUT_MS);
    for (;;) {
      let m;
      while ((m = receiveMessageOnPort(this.port))) {
        if (m.message.id !== id) continue;
        if (!m.message.ok) throw new DbError(m.message.error);
        return m.message.result;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('O banco de dados não respondeu a tempo. Tente de novo.');
      const cur = Atomics.load(this.flag, 0);
      if (cur !== id) Atomics.wait(this.flag, 0, cur, Math.min(left, 1000));
    }
  }

  _raw(op, sql, params) { return this._call({ op, sql, params }); }
  _query(sql, params) { return this._raw('query', toPg(sql).sql, params.map(fixParam)); }

  prepare(sql) { return new Statement(this, sql); }
  exec(sql) { this._raw('exec', toPg(sql).sql); }
  storagePut(name, data, type) { return this._call({ op: 'storage_put', name, data, type }); }
  storageGet(name) { return this._call({ op: 'storage_get', name }); }
  close() { try { this._call({ op: 'close' }); } catch { /* já fechado */ } this.worker.terminate(); }
}

/**
 * Abre o banco e garante o esquema. url: DATABASE_URL do Supabase ou "memory:" (Postgres em memória, para testes).
 * storage: { url, key, bucket } do Supabase Storage para os comprovantes (sem isso, ficam numa pasta local).
 */
export function openDb(url = process.env.DATABASE_URL || 'memory:', opts = {}) {
  const storage = opts.storage !== undefined ? opts.storage
    : (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: process.env.SUPABASE_URL.replace(/\/+$/, ''), key: process.env.SUPABASE_SERVICE_ROLE_KEY, bucket: process.env.SUPABASE_BUCKET || 'comprovantes' }
      : null);
  const db = new Database(url, { storage });
  if (!db.prepare("SELECT to_regtype('citext') AS t").get().t) db.exec('CREATE EXTENSION IF NOT EXISTS citext');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  const v = db.prepare('SELECT version FROM schema_version').get();
  if (!v) db.prepare('INSERT INTO schema_version(version) VALUES (2)').run();
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, val] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, val);
  return db;
}

export const nowIso = () => new Date().toISOString();

/** Executa fn dentro de uma transação; desfaz tudo se algo falhar. */
export function tx(db, fn) {
  if (db._inTx) return fn(); // já está numa transação (chamada aninhada)
  db.exec('BEGIN');
  db._inTx = true;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* conexão caiu: o Postgres já desfez */ }
    throw e;
  } finally { db._inTx = false; }
}

/**
 * Dentro de uma transação, um erro do banco no Postgres invalida a transação inteira. Para trechos que
 * tratam o erro e seguem em frente (ex.: pular uma linha ruim na importação), use este "ponto de retorno".
 */
export function savepoint(db, fn) {
  if (!db._inTx) return fn();
  db.exec('SAVEPOINT sp');
  try { const r = fn(); db.exec('RELEASE SAVEPOINT sp'); return r; } catch (e) { db.exec('ROLLBACK TO SAVEPOINT sp'); throw e; }
}

export function audit(db, action, entity, entityId, before, after) {
  db.prepare('INSERT INTO audit_log(at, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?)')
    .run(nowIso(), action, entity, entityId ?? null,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after));
}

export function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : DEFAULT_SETTINGS[key];
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export const plain = (r) => (r ? { ...r } : r);
export const all = (db, sql, ...p) => db.prepare(sql).all(...p).map(plain);
export const one = (db, sql, ...p) => plain(db.prepare(sql).get(...p));

/** Todas as tabelas do app, na ordem em que podem ser restauradas (respeitando as ligações). */
export const TABLES = ['schema_version', 'owner', 'settings', 'lists', 'barbers', 'barber_notes', 'services', 'products', 'stock_movements',
  'appointments', 'appointment_items', 'counter_sales', 'counter_sale_items', 'import_batches', 'online_orders', 'online_order_items',
  'payables', 'cash_outs', 'cash_accounts', 'closings', 'audit_log', 'receipts', 'sessions', 'login_attempts'];
