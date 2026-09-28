import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SETTINGS = {
  commission_pct_default: '0.5',     // 50%, igual à planilha
  commission_base: 'tabela',         // 'tabela' = sobre o preço dos serviços (como na planilha) | 'apos_desconto'
  return_restock_default: '1',       // devolução online volta ao estoque por padrão
  low_stock_alert: '1',
};

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  // migrações simples para bancos criados por versões anteriores
  const cols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!cols.includes('commission_base_mode')) db.exec('ALTER TABLE appointments ADD COLUMN commission_base_mode TEXT');
  const v = db.prepare('SELECT version FROM schema_version').get();
  if (!v) db.prepare('INSERT INTO schema_version(version) VALUES (1)').run();
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, val] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, val);
  return db;
}

export const nowIso = () => new Date().toISOString();

/** Executa fn dentro de uma transação; desfaz tudo se algo falhar. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
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

/** Converte linhas do node:sqlite (objetos sem protótipo) em objetos comuns. */
export const plain = (r) => (r ? { ...r } : r);
export const all = (db, sql, ...p) => db.prepare(sql).all(...p).map(plain);
export const one = (db, sql, ...p) => plain(db.prepare(sql).get(...p));
