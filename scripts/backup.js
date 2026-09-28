// Baixa uma cópia completa do banco (Supabase) para dados/backups/, em JSON.
// Uso: DATABASE_URL=... npm run backup     — restaurar: npm run restaurar-backup <arquivo.json>
// (No site, a mesma cópia sai em Cadastros → Backup → "Baixar backup completo".)
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { backupData } from '../server/routes/exportar.js';

if (!process.env.DATABASE_URL) { console.error('Defina DATABASE_URL (conexão do Supabase).'); process.exit(1); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.BACKUP_DIR || join(root, 'dados', 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const out = join(dir, `verdugo-${stamp}.json`);
const db = openDb(process.env.DATABASE_URL);
writeFileSync(out, JSON.stringify(backupData(db)));
console.log(`Backup salvo em ${out}`);
// guarda os 60 mais recentes
const files = readdirSync(dir).filter((f) => f.startsWith('verdugo-') && f.endsWith('.json')).sort();
for (const f of files.slice(0, Math.max(0, files.length - 60))) rmSync(join(dir, f));
db.close();
