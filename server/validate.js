// Validação de entrada. Tudo que é número é conferido AQUI, no servidor: texto digitado por engano
// num campo numérico é recusado com uma mensagem clara e NUNCA chega ao banco nem aos totais.

export class ValidationError extends Error {
  constructor(message, field) { super(message); this.status = 400; this.field = field; }
}

const BR = /^-?\d{1,3}(\.\d{3})*(,\d{1,2})?$|^-?\d+(,\d{1,2})?$/;   // 1.234,56 | 1234,5 | 45
const DOT = /^-?\d+(\.\d{1,2})?$/;                                   // 1234.56

/** Converte "R$ 1.234,56", "1234,56", "1234.56" ou 1234.56 em centavos (inteiro). */
export function parseMoney(value, field = 'valor', { allowNegative = false, required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(`Informe ${field}.`, field);
    return 0;
  }
  let cents;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`${cap(field)} precisa ser um número.`, field);
    cents = Math.round(value * 100);
  } else if (typeof value === 'string') {
    const s = value.replace(/R\$/gi, '').replace(/\s/g, '');
    if (BR.test(s)) cents = Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
    else if (DOT.test(s)) cents = Math.round(Number(s) * 100);
    else throw new ValidationError(`${cap(field)} precisa ser um valor em reais (ex.: 45,00). Recebido: "${value}".`, field);
  } else {
    throw new ValidationError(`${cap(field)} precisa ser um número.`, field);
  }
  if (!allowNegative && cents < 0) throw new ValidationError(`${cap(field)} não pode ser negativo.`, field);
  if (Math.abs(cents) > 100_000_000_00) throw new ValidationError(`${cap(field)} está alto demais — confira.`, field);
  return cents;
}

export function parseInt0(value, field = 'quantidade', { min = 1, max = 100000, required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(`Informe ${field}.`, field);
    return null;
  }
  const s = typeof value === 'number' ? String(value) : String(value).trim();
  if (!/^-?\d+$/.test(s)) throw new ValidationError(`${cap(field)} precisa ser um número inteiro (ex.: 2). Recebido: "${value}".`, field);
  const n = Number(s);
  if (n < min) throw new ValidationError(`${cap(field)} precisa ser no mínimo ${min}.`, field);
  if (n > max) throw new ValidationError(`${cap(field)} está alto demais — confira.`, field);
  return n;
}

export function parsePct(value, field = 'porcentagem') {
  if (value === null || value === undefined || value === '') return null;
  let n;
  if (typeof value === 'number') n = value;
  else {
    const s = String(value).replace('%', '').replace(',', '.').trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new ValidationError(`${cap(field)} precisa ser um número (ex.: 50).`, field);
    n = Number(s);
  }
  // sempre em PORCENTAGEM: "50" = 50%, "1" = 1%, "0,5" = 0,5%
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new ValidationError(`${cap(field)} precisa ficar entre 0 e 100%.`, field);
  return Math.round(n * 100) / 10000;
}

/** Aceita 'AAAA-MM-DD' ou 'DD/MM/AAAA'. Devolve 'AAAA-MM-DD'. */
export function parseDate(value, field = 'data', { required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(`Informe ${field}.`, field);
    return null;
  }
  const s = String(value).trim();
  // data com horário e fuso (ex.: 2026-09-10T01:30:00Z): converte para o dia em São Paulo
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = new Date(s.replace(' ', 'T'));
    if (!Number.isNaN(t.getTime())) return todaySP(t);
  }
  let y, m, d;
  let mt = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (mt) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: .*)?$/))) [, d, m, y] = mt;
  else throw new ValidationError(`${cap(field)} inválida (use DD/MM/AAAA). Recebido: "${value}".`, field);
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d)
    throw new ValidationError(`${cap(field)} inválida: "${value}".`, field);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function text(value, field, { required = false, max = 500 } = {}) {
  const s = value === null || value === undefined ? '' : String(value).trim();
  if (!s && required) throw new ValidationError(`Informe ${field}.`, field);
  if (s.length > max) throw new ValidationError(`${cap(field)} está longo demais (máx. ${max} caracteres).`, field);
  return s || null;
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new ValidationError(`${cap(field)} inválido(a): "${value}".`, field);
  return value;
}

export function parseId(value, field = 'id', { required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(`Selecione ${field}.`, field);
    return null;
  }
  const s = String(value);
  if (!/^\d+$/.test(s)) throw new ValidationError(`${cap(field)} inválido.`, field);
  return Number(s);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Datas no fuso de São Paulo ----------
const TZ = 'America/Sao_Paulo';

export function todaySP(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return p; // AAAA-MM-DD
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Semana de segunda a domingo que contém a data. */
export function weekRange(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo
  const start = addDays(iso, dow === 0 ? -6 : 1 - dow);
  return { start, end: addDays(start, 6) };
}

export function monthRange(iso) {
  const [y, m] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

export function parsePeriod(q, fallback = 'mes') {
  const today = todaySP();
  const kind = q.periodo || fallback;
  if (kind === 'semana') return { kind, ...weekRange(q.ref ? parseDate(q.ref, 'data de referência') : today) };
  if (kind === 'mes') return { kind, ...monthRange(q.ref ? parseDate(q.ref, 'data de referência') : today) };
  if (kind === 'hoje') return { kind, start: today, end: today };
  const start = parseDate(q.inicio, 'data inicial');
  const end = parseDate(q.fim, 'data final');
  if (end < start) throw new ValidationError('A data final é anterior à inicial.', 'fim');
  return { kind: 'personalizado', start, end };
}
