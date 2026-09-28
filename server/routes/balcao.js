import { Router } from 'express';
import { h, notFound, HttpError } from '../http.js';
import { tx, audit, nowIso, all, one } from '../db.js';
import { text, parseMoney, parseDate, parseId, parseInt0, todaySP, ValidationError } from '../validate.js';
import { syncItemStock, neutralizeRemovedItems, productBySku, balanceOf } from '../services/stock.js';

export function loadSale(db, id) {
  const s = one(db, `SELECT v.*, b.name AS seller_name FROM counter_sales v LEFT JOIN barbers b ON b.id=v.seller_barber_id WHERE v.id=?`, id);
  if (!s) return null;
  s.items = all(db, 'SELECT * FROM counter_sale_items WHERE sale_id=? ORDER BY position, id', id);
  return s;
}

function build(db, body, existing) {
  const date = parseDate(body.date ?? todaySP(), 'data da venda');
  const pay = one(db, "SELECT name FROM lists WHERE kind='pagamento' AND name=?", String(body.payment_method || ''));
  if (!pay) throw new ValidationError('Selecione uma forma de pagamento válida.', 'payment_method');
  const sellerId = parseId(body.seller_barber_id, 'responsável', { required: false });
  if (sellerId && !one(db, 'SELECT id FROM barbers WHERE id=?', sellerId)) throw new ValidationError('Responsável não encontrado.', 'seller_barber_id');

  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) throw new ValidationError('Adicione pelo menos um produto.', 'items');
  const items = raw.map((it, idx) => {
    if (!it || typeof it !== 'object') throw new ValidationError(`Linha ${idx + 1} dos produtos está vazia.`, 'items');
    let p = null;
    if (it.product_id) p = one(db, 'SELECT * FROM products WHERE id=?', parseId(it.product_id, `produto da linha ${idx + 1}`));
    else if (it.sku) p = productBySku(db, it.sku);
    if (!p) throw new ValidationError(`Produto da linha ${idx + 1} não encontrado — use um SKU cadastrado.`, 'items');
    const old = existing?.items?.find((o) => o.id === it.id && o.product_id === p.id);
    if (!p.active && !old) throw new ValidationError(`O produto ${p.sku} está desativado.`, 'items');
    const qty = parseInt0(it.qty, `quantidade de ${p.sku}`);
    const price = (it.price === undefined || it.price === null || it.price === '')
      ? (old ? old.unit_price_cents : p.price_cents) : parseMoney(it.price, `preço de ${p.sku}`);
    if (price === 0 && p.price_pending) throw new ValidationError(`O preço de ${p.sku} ainda não foi confirmado — informe o preço na venda.`, 'items');
    return { id: old?.id ?? null, product_id: p.id, sku: p.sku, product_name: p.name, qty, unit_price_cents: price, position: idx };
  });
  const subtotal = items.reduce((s, i) => s + i.qty * i.unit_price_cents, 0);
  const discount = parseMoney(body.discount ?? 0, 'desconto', { required: false });
  if (discount > subtotal) throw new ValidationError('O desconto é maior que o valor dos produtos.', 'discount');
  const total = subtotal - discount;
  const received = (body.received === undefined || body.received === null || body.received === '') ? total : parseMoney(body.received, 'valor recebido');
  if (received > total) throw new ValidationError('O valor recebido está maior que o total da venda — confira.', 'received');
  return { date, payment_method: pay.name, seller_barber_id: sellerId, subtotal_cents: subtotal, discount_cents: discount,
    total_cents: total, received_cents: received, card_fee_cents: total - received,
    note: text(body.note, 'observação', { max: 1000 }), items };
}

/** Grava os itens e acerta o estoque de cada um (idempotente). */
function saveItemsAndStock(db, saleId, sale, status) {
  const keep = [];
  const upd = db.prepare('UPDATE counter_sale_items SET product_id=?, sku=?, product_name=?, qty=?, unit_price_cents=?, position=? WHERE id=? AND sale_id=?');
  const ins = db.prepare('INSERT INTO counter_sale_items(sale_id, product_id, sku, product_name, qty, unit_price_cents, position) VALUES (?,?,?,?,?,?,?)');
  const existingIds = all(db, 'SELECT id FROM counter_sale_items WHERE sale_id=?', saleId).map((x) => x.id);
  for (const it of sale.items) {
    let id = it.id;
    if (id && existingIds.includes(id)) upd.run(it.product_id, it.sku, it.product_name, it.qty, it.unit_price_cents, it.position, id, saleId);
    else id = Number(ins.run(saleId, it.product_id, it.sku, it.product_name, it.qty, it.unit_price_cents, it.position).lastInsertRowid);
    keep.push(id);
    syncItemStock(db, { source: 'balcao', sourceId: saleId, itemId: id, productId: it.product_id,
      desiredQty: status === 'ativo' ? -it.qty : 0, date: sale.date, saleKind: 'venda_balcao', reasonKind: 'estorno',
      note: `Venda de balcão #${saleId}` });
  }
  for (const oldId of existingIds.filter((x) => !keep.includes(x))) db.prepare('DELETE FROM counter_sale_items WHERE id=?').run(oldId);
  neutralizeRemovedItems(db, 'balcao', saleId, keep, sale.date, `Item removido da venda #${saleId}`);
}

function stockWarnings(db, sale) {
  const w = [];
  for (const it of sale.items) {
    const s = balanceOf(db, it.product_id);
    if (s < 0) w.push(`Estoque de ${it.sku} ficou negativo (${s}). Confira o saldo ou registre a entrada.`);
  }
  return w;
}

export default function balcao(db) {
  const r = Router();

  r.get('/balcao', h((req) => {
    const ini = req.query.inicio ? parseDate(req.query.inicio, 'data inicial') : '0000-01-01';
    const fim = req.query.fim ? parseDate(req.query.fim, 'data final') : '9999-12-31';
    const rows = all(db, `SELECT v.*, b.name AS seller_name FROM counter_sales v LEFT JOIN barbers b ON b.id=v.seller_barber_id
                          WHERE v.date BETWEEN ? AND ? ORDER BY v.date DESC, v.id DESC LIMIT 5000`, ini, fim);
    const its = db.prepare('SELECT * FROM counter_sale_items WHERE sale_id=? ORDER BY position, id');
    for (const s of rows) s.items = its.all(s.id).map((x) => ({ ...x }));
    return rows;
  }));

  r.get('/balcao/:id', h((req) => loadSale(db, parseId(req.params.id)) ?? (() => { throw notFound('Venda'); })()));

  r.post('/balcao', h((req) => tx(db, () => {
    const s = build(db, req.body);
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO counter_sales(date, payment_method, seller_barber_id, subtotal_cents, discount_cents, total_cents,
        received_cents, card_fee_cents, note, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'ativo',?,?)`)
      .run(s.date, s.payment_method, s.seller_barber_id, s.subtotal_cents, s.discount_cents, s.total_cents, s.received_cents,
        s.card_fee_cents, s.note, now, now).lastInsertRowid);
    saveItemsAndStock(db, id, s, 'ativo');
    const row = loadSale(db, id);
    audit(db, 'criar', 'venda_balcao', id, undefined, row);
    return { ...row, avisos: stockWarnings(db, s) };
  })));

  r.put('/balcao/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = loadSale(db, id);
    if (!before) throw notFound('Venda');
    const s = build(db, req.body, before);
    db.prepare(`UPDATE counter_sales SET date=?, payment_method=?, seller_barber_id=?, subtotal_cents=?, discount_cents=?, total_cents=?,
        received_cents=?, card_fee_cents=?, note=?, updated_at=? WHERE id=?`)
      .run(s.date, s.payment_method, s.seller_barber_id, s.subtotal_cents, s.discount_cents, s.total_cents, s.received_cents,
        s.card_fee_cents, s.note, nowIso(), id);
    saveItemsAndStock(db, id, s, before.status);
    const after = loadSale(db, id);
    audit(db, 'editar', 'venda_balcao', id, before, after);
    return { ...after, avisos: stockWarnings(db, s) };
  })));

  for (const [path, status] of [['cancelar', 'cancelado'], ['reativar', 'ativo']]) {
    r.post(`/balcao/:id/${path}`, h((req) => tx(db, () => {
      const id = parseId(req.params.id);
      const before = loadSale(db, id);
      if (!before) throw notFound('Venda');
      if (before.status === status) throw new HttpError(409, `Venda já está ${status}.`);
      db.prepare('UPDATE counter_sales SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), id);
      saveItemsAndStock(db, id, { ...before, items: before.items }, status); // cancelar devolve ao estoque; reativar baixa de novo
      const after = loadSale(db, id);
      audit(db, path, 'venda_balcao', id, before, after);
      return after;
    })));
  }

  return r;
}
