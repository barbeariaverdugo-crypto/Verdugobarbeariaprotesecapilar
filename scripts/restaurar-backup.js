// Restaura um backup completo (.json gerado pelo app) — APAGA os dados atuais e coloca os do arquivo.
// Uso: DATABASE_URL=... npm run restaurar-backup dados/backups/verdugo-AAAA-MM-DD-....json
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { openDb, tx, TABLES, audit } from '../server/db.js';

export function restoreBackup(db, dump) {
  if (dump?.app !== 'verdugo' || !dump.tabelas) throw new Error('Arquivo não parece um backup do Verdugo.');
  return tx(db, () => {
    db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const count = {};
    for (const t of TABLES) {
      const rows = dump.tabelas[t] || [];
      count[t] = rows.length;
      for (const row of rows) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ${t}(${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
      }
      // próximos ids continuam depois do maior id restaurado
      const hasIdentity = db.prepare(`SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = 'id' AND is_identity = 'YES'`).get(t);
      if (hasIdentity && rows.length) db.exec(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT MAX(id) FROM ${t}))`);
    }
    audit(db, 'restaurar_backup', 'banco', null, undefined, { gerado_em: dump.gerado_em, linhas: count });
    return count;
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error('Uso: DATABASE_URL=... npm run restaurar-backup <arquivo.json>'); process.exit(1); }
  const dump = JSON.parse(readFileSync(file, 'utf8'));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ok = await rl.question(`Isso APAGA os dados atuais e restaura o backup de ${dump.gerado_em}. Digite RESTAURAR para confirmar: `);
  rl.close();
  if (ok.trim() !== 'RESTAURAR') { console.log('Cancelado.'); process.exit(0); }
  const db = openDb(process.env.DATABASE_URL);
  console.log(restoreBackup(db, dump));
  db.close();
}
