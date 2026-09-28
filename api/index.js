// Entrada do app na Vercel: todas as rotas (telas e /api) passam por aqui.
import 'pg'; // o driver do Postgres é usado pela thread do banco (server/db-worker.js); o import garante que a Vercel o inclua
import { createApp } from '../server/index.js';

process.env.TRUST_PROXY ??= '1';     // a Vercel fica na frente: o IP real do visitante vem no cabeçalho
process.env.COOKIE_SECURE ??= '1';   // site sempre em HTTPS

let handler;
if (!process.env.DATABASE_URL) {
  // sem banco configurado, NÃO sobe com banco em memória (os dados sumiriam): mostra o que falta
  handler = (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Falta configurar DATABASE_URL (conexão do Supabase) nas variáveis de ambiente da Vercel.');
  };
} else {
  handler = createApp({ databaseUrl: process.env.DATABASE_URL });
}
export default handler;
