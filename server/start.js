// Liga o servidor. Usado por "npm start" (computador) e por app.cjs (cPanel / Passenger).
// Tudo que muda entre um lugar e outro vem de variáveis de ambiente — nada de porta ou caminho de produção fixo no código.
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

export function start() {
  // DB_FILE: onde fica o banco SQLite. No cPanel, aponte para uma pasta PRIVADA e fora da pasta do app
  // (ex.: /home/USUARIO/verdugo-dados/verdugo.db), para que atualizar o app nunca sobrescreva os dados.
  const dbFile = resolve(process.env.DB_FILE || join(here, '..', 'dados', 'verdugo.db'));
  // Comprovantes: por padrão, pasta "comprovantes" ao lado do banco (também privada e persistente).
  const uploadsDir = process.env.UPLOADS_DIR ? resolve(process.env.UPLOADS_DIR) : join(dirname(dbFile), 'comprovantes');
  const app = createApp({ dbFile, uploadsDir });
  const owner = app.locals.db.prepare('SELECT email FROM owner WHERE id=1').get();
  // No cPanel, o Passenger intercepta este listen e liga o app ao subdomínio; a porta real é dele.
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => {
    console.log(`Verdugo no ar (${process.env.NODE_ENV || 'desenvolvimento'})`);
    console.log(`Banco de dados: ${dbFile}`);
    console.log(`Comprovantes: ${uploadsDir}`);
    if (!owner) console.log('Nenhuma conta criada ainda: abra /configurar (com SETUP_TOKEN definido) ou rode  npm run definir-senha');
  });
  return { app, server };
}
