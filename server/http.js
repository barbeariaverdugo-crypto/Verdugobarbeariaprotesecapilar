import { ValidationError } from './validate.js';

/** Envolve um handler: erros de validação viram 400 com mensagem em português; o resto vira 500 genérico. */
export const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) { next(e); }
};

/** Mesmo que h(), para rotas que devolvem uma resposta própria (arquivo, CSV) ou que são assíncronas. */
export const ha = (fn) => (req, res, next) => { Promise.resolve().then(() => fn(req, res)).catch(next); };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ValidationError || err instanceof HttpError) {
    return res.status(err.status).json({ erro: err.message, campo: err.field });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ erro: 'Dados enviados em formato inválido.' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo grande demais (máx. 5 MB).' });
  const msg = String(err?.message || '');
  if (err?.code === '23505' || msg.includes('UNIQUE constraint failed')) return res.status(409).json({ erro: 'Já existe um registro com esse identificador/nome.' });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno. Nada foi gravado pela metade — tente de novo.' });
}

export const notFound = (what = 'Registro') => new HttpError(404, `${what} não encontrado.`);
