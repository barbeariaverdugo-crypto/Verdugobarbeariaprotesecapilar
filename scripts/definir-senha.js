// Cria (ou troca) a ÚNICA conta de acesso: a do proprietário.
// Uso interativo:   npm run definir-senha
// Sem perguntas:    VERDUGO_EMAIL=voce@exemplo.com VERDUGO_SENHA='...' npm run definir-senha
import { createInterface } from 'node:readline/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { setOwner, validatePasswordStrength } from '../server/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb(process.env.DB_FILE || join(root, 'dados', 'verdugo.db'));

let email = process.env.VERDUGO_EMAIL;
let senha = process.env.VERDUGO_SENHA;
if (!email || !senha) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  email = email || (await rl.question('E-mail do proprietário: '));
  senha = senha || (await rl.question('Senha (mín. 10 caracteres, letras e números): '));
  rl.close();
}
const err = validatePasswordStrength(senha);
if (!email || !email.includes('@')) { console.error('E-mail inválido.'); process.exit(1); }
if (err) { console.error(err); process.exit(1); }
setOwner(db, email, senha);
console.log(`Conta do proprietário definida para ${email.trim().toLowerCase()}. Sessões antigas foram encerradas.`);
