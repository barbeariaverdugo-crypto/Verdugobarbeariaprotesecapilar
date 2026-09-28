// Primeira configuração pelo navegador (no site publicado não há terminal para rodar "npm run definir-senha").
// Só funciona enquanto NÃO existe conta, e só com o código SETUP_TOKEN definido nas variáveis do servidor.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { one, nowIso, tx, audit } from './db.js';
import { setOwner, validatePasswordStrength, tooManyFails } from './auth.js';
import { importPlanilha } from '../scripts/importar-planilha.js';
import { HttpError } from './http.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (s) => createHash('sha256').update(String(s)).digest();

export const hasOwner = (db) => !!one(db, 'SELECT id FROM owner WHERE id = 1');

export function setupHandler(db) {
  return (req, res) => {
    if (hasOwner(db)) return res.status(410).json({ erro: 'A conta já foi criada. Entre pela tela de login.' });
    const expected = process.env.SETUP_TOKEN;
    if (!expected || expected.length < 12) return res.status(503).json({ erro: 'Defina a variável SETUP_TOKEN (mín. 12 caracteres) no cPanel (Setup Node.js App) e reinicie o app.' });
    const ip = req.ip || 'desconhecido';
    if (tooManyFails(db, ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.' });
    const { token, email, senha, importar } = req.body || {};
    if (!timingSafeEqual(digest(token), digest(expected))) {
      db.prepare('INSERT INTO login_attempts(ip, at, ok) VALUES (?, ?, 0)').run(ip, nowIso());
      return res.status(401).json({ erro: 'Código de configuração incorreto.' });
    }
    if (!email || !String(email).includes('@')) return res.status(400).json({ erro: 'Informe um e-mail válido.' });
    const err = validatePasswordStrength(senha);
    if (err) return res.status(400).json({ erro: err });
    let rep = null;
    tx(db, () => {
      if (hasOwner(db)) throw new HttpError(410, 'A conta já foi criada.');
      setOwner(db, email, senha);
      audit(db, 'criar', 'conta_proprietario', 1, undefined, { email: String(email).trim().toLowerCase(), via: 'configurar' });
    });
    if (importar) {
      const file = process.env.PLANILHA_FILE || join(root, 'dados', 'planilha_extraida.json');
      if (!existsSync(file)) return res.json({ ok: true, mensagem: `Conta criada. O arquivo da planilha não está no servidor, então nada foi importado. Indo para o login…` });
      rep = importPlanilha(db, JSON.parse(readFileSync(file, 'utf8')));
    }
    const resumo = rep ? ` Importados: ${rep.barbeiros} barbeiros, ${rep.servicos} serviços, ${rep.produtos} produtos, ${rep.contas} contas e ${rep.caixas} caixas.` : '';
    res.json({ ok: true, mensagem: `Conta criada para ${String(email).trim().toLowerCase()}.${resumo} Agora apague o arquivo dados/planilha_extraida.json do servidor. Indo para o login…`, importacao: rep });
  };
}
