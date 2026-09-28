import { Router } from 'express';
import { h, notFound, HttpError } from '../http.js';
import { tx, audit, nowIso, all, one, getSetting } from '../db.js';
import { text, parseMoney, parseDate, parseId, todaySP, ValidationError } from '../validate.js';

function paymentOk(db, name) {
  const p = one(db, "SELECT name FROM lists WHERE kind='pagamento' AND name=?", name);
  if (!p) throw new ValidationError('Selecione uma forma de pagamento válida.', 'payment_method');
  return p.name;
}

export function loadAppointment(db, id) {
  const a = one(db, `SELECT a.*, b.name AS barber_name FROM appointments a JOIN barbers b ON b.id=a.barber_id WHERE a.id=?`, id);
  if (!a) return null;
  a.items = all(db, 'SELECT * FROM appointment_items WHERE appointment_id=? ORDER BY is_main DESC, position, id', id);
  return a;
}

/** Calcula e valida um atendimento a partir do que veio do formulário. */
function build(db, body, existing) {
  const date = parseDate(body.date ?? todaySP(), 'data do atendimento');
  const barberId = parseId(body.barber_id, 'o barbeiro');
  const barber = one(db, 'SELECT * FROM barbers WHERE id=?', barberId);
  if (!barber) throw new ValidationError('Barbeiro não encontrado.', 'barber_id');
  if (!barber.active && (!existing || existing.barber_id !== barberId))
    throw new ValidationError('Esse barbeiro está desativado.', 'barber_id');
  const payment = paymentOk(db, String(body.payment_method || ''));

  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) throw new ValidationError('Adicione pelo menos o serviço principal.', 'items');
  if (raw.length > 30) throw new ValidationError('Itens demais em um atendimento.', 'items');
  raw.forEach((it, idx) => { if (!it || typeof it !== 'object') throw new ValidationError(`Linha ${idx + 1} dos serviços está vazia.`, 'items'); });
  let mainIdx = raw.findIndex((i) => i.is_main);
  if (mainIdx < 0) mainIdx = 0;
  if (raw.filter((i) => i.is_main).length > 1) throw new ValidationError('Marque apenas um serviço principal.', 'items');

  const items = raw.map((it, idx) => {
    if (!it || typeof it !== 'object') throw new ValidationError(`Linha ${idx + 1} dos serviços está vazia.`, 'items');
    const sid = parseId(it.service_id, `o serviço da linha ${idx + 1}`);
    const svc = one(db, 'SELECT * FROM services WHERE id=?', sid);
    if (!svc) throw new ValidationError(`Serviço da linha ${idx + 1} não encontrado.`, 'items');
    const keepOld = existing?.items?.find((o) => o.id === it.id && o.service_id === sid);
    if (!svc.active && !keepOld) throw new ValidationError(`O serviço "${svc.name}" está desativado.`, 'items');
    const price = (it.price === undefined || it.price === null || it.price === '')
      ? (keepOld ? keepOld.price_cents : svc.price_cents)
      : parseMoney(it.price, `preço de "${svc.name}"`);
    return { service_id: sid, service_name: keepOld ? keepOld.service_name : svc.name, price_cents: price,
      is_main: idx === mainIdx ? 1 : 0, position: idx };
  });

  const subtotal = items.reduce((s, i) => s + i.price_cents, 0);
  const discount = parseMoney(body.discount ?? 0, 'desconto', { required: false });
  if (discount > subtotal) throw new ValidationError('O desconto é maior que o valor dos serviços.', 'discount');
  const total = subtotal - discount;
  const received = (body.received === undefined || body.received === null || body.received === '')
    ? total : parseMoney(body.received, 'valor recebido');
  if (received > total) throw new ValidationError('O valor recebido está maior que o total do atendimento — confira.', 'received');

  // % de comissão fica congelada no lançamento (mudar a % depois não altera atendimentos antigos)
  const pct = existing && existing.barber_id === barberId
    ? existing.commission_pct
    : (barber.commission_pct ?? Number(getSetting(db, 'commission_pct_default')));
  // a forma de calcular (antes/depois do desconto) também fica congelada no lançamento
  const mode = existing?.commission_base_mode || (existing ? inferMode(existing) : null) || getSetting(db, 'commission_base');
  const base = mode === 'apos_desconto' ? total : subtotal;
  const commission = Math.round(base * pct);

  return {
    date, barber_id: barberId, payment_method: payment, subtotal_cents: subtotal, discount_cents: discount,
    total_cents: total, received_cents: received, card_fee_cents: total - received, commission_pct: pct,
    commission_base_mode: mode, commission_base_cents: base, commission_cents: commission,
    note: text(body.note, 'observação', { max: 1000 }), items,
  };
}

/** Atendimentos antigos sem o modo gravado: deduz pelo valor-base que foi usado. */
function inferMode(a) {
  if (a.discount_cents > 0 && a.commission_base_cents === a.total_cents) return 'apos_desconto';
  if (a.discount_cents > 0) return 'tabela';
  return null;
}

function saveItems(db, apptId, items) {
  db.prepare('DELETE FROM appointment_items WHERE appointment_id=?').run(apptId);
  const ins = db.prepare('INSERT INTO appointment_items(appointment_id, service_id, service_name, price_cents, is_main, position) VALUES (?,?,?,?,?,?)');
  for (const i of items) ins.run(apptId, i.service_id, i.service_name, i.price_cents, i.is_main, i.position);
}

export default function atendimentos(db) {
  const r = Router();

  r.get('/atendimentos', h((req) => {
    const ini = req.query.inicio ? parseDate(req.query.inicio, 'data inicial') : '0000-01-01';
    const fim = req.query.fim ? parseDate(req.query.fim, 'data final') : '9999-12-31';
    const bid = req.query.barbeiro ? parseId(req.query.barbeiro, 'barbeiro') : null;
    const rows = all(db, `SELECT a.*, b.name AS barber_name FROM appointments a JOIN barbers b ON b.id=a.barber_id
                          WHERE a.date BETWEEN ? AND ? AND (? IS NULL OR a.barber_id = ?)
                          ORDER BY a.date DESC, a.id DESC LIMIT 5000`, ini, fim, bid, bid);
    const its = db.prepare('SELECT * FROM appointment_items WHERE appointment_id=? ORDER BY is_main DESC, position, id');
    for (const a of rows) a.items = its.all(a.id).map((x) => ({ ...x }));
    return rows;
  }));

  r.get('/atendimentos/:id', h((req) => loadAppointment(db, parseId(req.params.id)) ?? (() => { throw notFound('Atendimento'); })()));

  r.post('/atendimentos', h((req) => tx(db, () => {
    const a = build(db, req.body);
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO appointments(date, barber_id, payment_method, subtotal_cents, discount_cents, total_cents,
        received_cents, card_fee_cents, commission_pct, commission_base_mode, commission_base_cents, commission_cents, note, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ativo',?,?)`)
      .run(a.date, a.barber_id, a.payment_method, a.subtotal_cents, a.discount_cents, a.total_cents, a.received_cents,
        a.card_fee_cents, a.commission_pct, a.commission_base_mode, a.commission_base_cents, a.commission_cents, a.note, now, now).lastInsertRowid);
    saveItems(db, id, a.items);
    const row = loadAppointment(db, id);
    audit(db, 'criar', 'atendimento', id, undefined, row);
    return row;
  })));

  r.put('/atendimentos/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = loadAppointment(db, id);
    if (!before) throw notFound('Atendimento');
    const a = build(db, req.body, before);
    db.prepare(`UPDATE appointments SET date=?, barber_id=?, payment_method=?, subtotal_cents=?, discount_cents=?, total_cents=?,
        received_cents=?, card_fee_cents=?, commission_pct=?, commission_base_mode=?, commission_base_cents=?, commission_cents=?, note=?, updated_at=? WHERE id=?`)
      .run(a.date, a.barber_id, a.payment_method, a.subtotal_cents, a.discount_cents, a.total_cents, a.received_cents,
        a.card_fee_cents, a.commission_pct, a.commission_base_mode, a.commission_base_cents, a.commission_cents, a.note, nowIso(), id);
    saveItems(db, id, a.items);
    const after = loadAppointment(db, id);
    audit(db, 'editar', 'atendimento', id, before, after);
    return after;
  })));

  for (const [path, status] of [['cancelar', 'cancelado'], ['reativar', 'ativo']]) {
    r.post(`/atendimentos/:id/${path}`, h((req) => tx(db, () => {
      const id = parseId(req.params.id);
      const before = loadAppointment(db, id);
      if (!before) throw notFound('Atendimento');
      if (before.status === status) throw new HttpError(409, `Atendimento já está ${status}.`);
      db.prepare('UPDATE appointments SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), id);
      const after = loadAppointment(db, id);
      audit(db, path, 'atendimento', id, before, after);
      return after;
    })));
  }

  return r;
}
