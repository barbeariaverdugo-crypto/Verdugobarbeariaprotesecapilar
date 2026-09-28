// Gera uma cópia consistente do banco em dados/backups/ (pode rodar com o app ligado).
// Uso: npm run backup     — para restaurar: pare o app e copie o arquivo de backup por cima de dados/verdugo.db
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = process.env.DB_FILE || join(root, 'dados', 'verdugo.db');
const dir = process.env.BACKUP_DIR || join(root, 'dados', 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = join(dir, `verdugo-${stamp}.sqlite`);
const db = openDb(dbFile);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
console.log(`Backup salvo em ${out}`);
// guarda os 60 mais recentes
const files = readdirSync(dir).filter((f) => f.startsWith('verdugo-') && f.endsWith('.sqlite')).sort();
for (const f of files.slice(0, Math.max(0, files.length - 60))) rmSync(join(dir, f));
