import { Router } from 'express';
import { h, notFound, HttpError } from '../http.js';
import { tx, audit, nowIso, all, one, getSetting } from '../db.js';
import { text, parseMoney, parseDate, parseId, parseInt0, oneOf, ValidationError } from '../validate.js';
import { syncItemStock, neutralizeRemovedItems, productBySku, onlineDesiredQty, onlineReasonKind } from '../services/stock.js';
import { CHANNELS } from '../services/reports.js';
import { parseCsv, norm, toCsv } from '../services/csv.js';

const CHANNEL_KEYS = Object.keys(CHANNELS);
const STATUSES = ['pago', 'enviado', 'entregue', 'cancelado', 'devolvido'];

export function loadOrder(db, id) {
  const o = one(db, 'SELECT * FROM online_orders WHERE id=?', id);
  if (!o) return null;
  o.items = all(db, 'SELECT * FROM online_order_items WHERE order_id=? ORDER BY id', id);
  return o;
}

/** Valida e normaliza um pedido (vindo do formulário ou de uma linha importada). */
export function normalizeOrder(db, body) {
  const channel = oneOf(body.channel, CHANNEL_KEYS, 'canal');
  const orderNumber = text(body.order_number, 'número do pedido', { required: true, max: 80 });
  const date = parseDate(body.date, 'data da venda');
  const status = oneOf(body.status || 'pago', STATUSES, 'status');
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) throw new ValidationError('Informe pelo menos um item (SKU e quantidade).', 'items');
  const bySku = new Map();
  for (const [idx, it] of raw.entries()) {
    if (!it || typeof it !== 'object') throw new ValidationError(`Linha ${idx + 1} dos itens está vazia.`, 'items');
    const sku = text(it.sku, `SKU da linha ${idx + 1}`, { required: true, max: 60 });
    const qty = parseInt0(it.qty, `quantidade do SKU ${sku}`);
    const unit = parseMoney(it.unit_price ?? 0, `preço unitário do SKU ${sku}`, { required: false });
    const key = sku.toUpperCase();
    const p = productBySku(db, sku);
    const prev = bySku.get(key);
    if (prev) { prev.qty += qty; continue; }
    bySku.set(key, { sku: p ? p.sku : sku, product_id: p ? p.id : null, product_name: p ? p.name : text(it.product_name, 'produto', { max: 200 }), qty, unit_price_cents: unit });
  }
  const items = [...bySku.values()];
  const itemsGross = items.reduce((s, i) => s + i.qty * i.unit_price_cents, 0);
  const gross = (body.gross === undefined || body.gross === null || body.gross === '') ? itemsGross : parseMoney(body.gross, 'valor bruto');
  const fees = parseMoney(body.fees ?? 0, 'taxas', { required: false });
  const shipping = parseMoney(body.shipping ?? 0, 'frete', { required: false });
  const discount = parseMoney(body.discount ?? 0, 'descontos', { required: false });
  const net = (body.net === undefined || body.net === null || body.net === '')
    ? gross - fees - shipping - discount
    : parseMoney(body.net, 'valor líquido', { allowNegative: true });
  const payout = parseDate(body.payout_date, 'data do repasse', { required: false });
  if (payout && payout < date) throw new ValidationError('A data do repasse é anterior à data da venda — confira.', 'payout_date');
  const restock = body.restock_on_return === undefined || body.restock_on_return === null || body.restock_on_return === ''
    ? (getSetting(db, 'return_restock_default') === '1' ? 1 : 0) : (body.restock_on_return ? 1 : 0);
  return { channel, order_number: orderNumber, date, status, restock_on_return: restock, gross_cents: gross, fees_cents: fees,
    shipping_cents: shipping, discount_cents: discount, net_cents: net, payout_date: payout,
    note: text(body.note, 'observação', { max: 1000 }), items };
}

const FIELDS = ['date', 'status', 'restock_on_return', 'gross_cents', 'fees_cents', 'shipping_cents', 'discount_cents', 'net_cents', 'payout_date', 'note'];

/**
 * Produto recém-cadastrado (ou com SKU corrigido): liga a ele os itens de pedidos que tinham chegado
 * com esse SKU ainda sem cadastro, e acerta o estoque desses pedidos.
 */
export function linkOrphanItems(db, product) {
  const orders = all(db, 'SELECT DISTINCT order_id FROM online_order_items WHERE product_id IS NULL AND sku = ? COLLATE NOCASE', product.sku);
  if (!orders.length) return 0;
  db.prepare('UPDATE online_order_items SET product_id = ?, product_name = COALESCE(product_name, ?) WHERE product_id IS NULL AND sku = ? COLLATE NOCASE')
    .run(product.id, product.name, product.sku);
  for (const o of orders) syncOrderStock(db, o.order_id);
  return orders.length;
}

/** Acerta o estoque de todos os itens do pedido conforme o status (idempotente). */
export function syncOrderStock(db, orderId) {
  const o = loadOrder(db, orderId);
  const keep = [];
  for (const it of o.items) {
    keep.push(it.id);
    syncItemStock(db, { source: 'online', sourceId: o.id, itemId: it.id, productId: it.product_id,
      desiredQty: onlineDesiredQty(o.status, o.restock_on_return, it.qty), date: o.date,
      saleKind: 'venda_online', reasonKind: onlineReasonKind(o.status),
      note: `${CHANNELS[o.channel]} pedido ${o.order_number} (${o.status})` });
  }
  neutralizeRemovedItems(db, 'online', o.id, keep, o.date, `Item removido do pedido ${o.order_number}`);
}

/**
 * Cria ou atualiza um pedido pelo identificador único (canal + número do pedido).
 * Reimportar o mesmo pedido NÃO duplica a venda nem a baixa de estoque.
 */
export function upsertOrder(db, data, { source = 'manual', batchId = null, allowUpdate = true } = {}) {
  const existing = one(db, 'SELECT * FROM online_orders WHERE channel=? AND order_number=?', data.channel, data.order_number);
  const now = nowIso();
  if (!existing) {
    const id = Number(db.prepare(`INSERT INTO online_orders(channel, order_number, date, status, restock_on_return, gross_cents, fees_cents,
        shipping_cents, discount_cents, net_cents, payout_date, note, source, import_batch_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(data.channel, data.order_number, data.date, data.status, data.restock_on_return, data.gross_cents, data.fees_cents,
        data.shipping_cents, data.discount_cents, data.net_cents, data.payout_date, data.note, source, batchId, now, now).lastInsertRowid);
    const ins = db.prepare('INSERT INTO online_order_items(order_id, product_id, sku, product_name, qty, unit_price_cents) VALUES (?,?,?,?,?,?)');
    for (const it of data.items) ins.run(id, it.product_id, it.sku, it.product_name, it.qty, it.unit_price_cents);
    syncOrderStock(db, id);
    const row = loadOrder(db, id);
    audit(db, 'criar', 'pedido_online', id, undefined, row);
    return { action: 'criado', id };
  }
  if (!allowUpdate) throw new HttpError(409, `O pedido ${data.order_number} já está cadastrado em ${CHANNELS[data.channel]}. Abra-o para editar.`);
  const before = loadOrder(db, existing.id);
  const oldItems = before.items.map((i) => `${i.sku.toUpperCase()}|${i.qty}|${i.unit_price_cents}|${i.product_id ?? ''}`).sort().join(',');
  const newItems = data.items.map((i) => `${i.sku.toUpperCase()}|${i.qty}|${i.unit_price_cents}|${i.product_id ?? ''}`).sort().join(',');
  const changed = FIELDS.some((f) => (before[f] ?? null) !== (data[f] ?? null)) || oldItems !== newItems;
  if (!changed) return { action: 'sem_alteracao', id: existing.id };
  db.prepare(`UPDATE online_orders SET date=?, status=?, restock_on_return=?, gross_cents=?, fees_cents=?, shipping_cents=?,
      discount_cents=?, net_cents=?, payout_date=?, note=?, updated_at=? WHERE id=?`)
    .run(data.date, data.status, data.restock_on_return, data.gross_cents, data.fees_cents, data.shipping_cents,
      data.discount_cents, data.net_cents, data.payout_date, data.note, now, existing.id);
  // itens: mantém o mesmo registro por SKU (para o estoque comparar com o que já foi baixado)
  const keepIds = [];
  for (const it of data.items) {
    const old = before.items.find((o) => o.sku.toUpperCase() === it.sku.toUpperCase());
    if (old) {
      db.prepare('UPDATE online_order_items SET product_id=?, sku=?, product_name=?, qty=?, unit_price_cents=? WHERE id=?')
        .run(it.product_id ?? old.product_id, it.sku, it.product_name ?? old.product_name, it.qty, it.unit_price_cents, old.id);
      keepIds.push(old.id);
    } else {
      keepIds.push(Number(db.prepare('INSERT INTO online_order_items(order_id, product_id, sku, product_name, qty, unit_price_cents) VALUES (?,?,?,?,?,?)')
        .run(existing.id, it.product_id, it.sku, it.product_name, it.qty, it.unit_price_cents).lastInsertRowid));
    }
  }
  for (const o of before.items) if (!keepIds.includes(o.id)) db.prepare('DELETE FROM online_order_items WHERE id=?').run(o.id);
  syncOrderStock(db, existing.id);
  const after = loadOrder(db, existing.id);
  audit(db, source === 'importacao' ? 'reimportar' : 'editar', 'pedido_online', existing.id, before, after);
  return { action: 'atualizado', id: existing.id };
}

// ---------- Importação de arquivo ----------
const ALIASES = {
  order_number: ['pedido', 'numero do pedido', 'n do pedido', 'no do pedido', 'id do pedido', 'order id', 'order number', 'numero da venda', 'n de venda', 'venda', 'id da venda'],
  date: ['data', 'data da venda', 'data do pedido', 'order date', 'created time', 'data de criacao', 'data de criacao do pedido'],
  sku: ['sku', 'sku do produto', 'seller sku', 'sku da variacao', 'sku de referencia', 'sku principal', 'codigo', 'codigo do produto'],
  product_name: ['produto', 'titulo', 'titulo do anuncio', 'product name', 'nome do produto'],
  qty: ['quantidade', 'qtd', 'qtde', 'unidades', 'quantity'],
  unit_price: ['preco unitario', 'preco', 'valor unitario', 'unit price', 'preco unitario de venda', 'preco original'],
  gross: ['valor bruto', 'bruto', 'total', 'valor total', 'receita por produtos', 'subtotal', 'order amount', 'total do pedido', 'valor da venda'],
  fees: ['taxas', 'tarifas', 'tarifa de venda', 'taxa', 'comissao', 'tarifa de venda e impostos', 'fees', 'taxa de comissao', 'taxas e encargos'],
  shipping: ['frete', 'custo de envio', 'tarifas de envio', 'shipping', 'frete vendedor', 'envios'],
  discount: ['desconto', 'descontos', 'cupom', 'discount'],
  net: ['valor liquido', 'liquido', 'total recebido', 'renda', 'repasse', 'net', 'valor a receber', 'renda estimada do pedido'],
  status: ['status', 'situacao', 'estado', 'order status', 'status do pedido'],
  payout_date: ['data do repasse', 'data de repasse', 'data de liberacao', 'payout date', 'data de pagamento', 'data da liberacao do dinheiro', 'repasse em'],
  note: ['observacao', 'obs', 'observacoes'],
};

export function mapStatus(v) {
  const s = norm(v);
  if (!s) return 'pago';
  if (/\b(nao|not|sem|aguardando pagamento|pendente de pagamento)\b/.test(s) || /\bun(paid|shipped|delivered)\b/.test(s))
    throw new ValidationError(`Status "${v}" indica pedido não pago ou não concluído — não importado. Importe de novo quando mudar.`, 'status');
  if (/devol|reembols|return|refund/.test(s) && s.includes('cancel'))
    throw new ValidationError(`Status "${v}" é ambíguo (devolução cancelada?) — lance este pedido manualmente.`, 'status');
  if (s.includes('cancel')) return 'cancelado';
  if (/(devol|reembols|return|refund|estorn)/.test(s)) return 'devolvido';
  if (/(entreg|deliver|concluid|complet|finaliz)/.test(s)) return 'entregue';
  if (/(enviad|em transito|transit|shipped|a caminho|despachad)/.test(s)) return 'enviado';
  if (/(pago|aprovad|paid|a enviar|pronto|confirmad|para enviar)/.test(s)) return 'pago';
  throw new ValidationError(`Status "${v}" não reconhecido (use pago, enviado, entregue, cancelado ou devolvido).`, 'status');
}

export function importCsv(db, { channel, filename, csv }) {
  oneOf(channel, CHANNEL_KEYS, 'canal');
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new ValidationError('O arquivo está vazio ou sem linhas de pedido.', 'arquivo');
  const header = rows[0].map(norm);
  const col = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const idx = header.findIndex((h) => names.includes(h));
    if (idx >= 0) col[field] = idx;
  }
  const missing = ['order_number', 'date', 'sku', 'qty'].filter((f) => col[f] === undefined);
  if (missing.length) {
    const nomes = { order_number: 'número do pedido', date: 'data', sku: 'SKU', qty: 'quantidade' };
    throw new ValidationError(`Não encontrei as colunas: ${missing.map((m) => nomes[m]).join(', ')}. Use o modelo de importação.`, 'arquivo');
  }
  // agrupa as linhas por número do pedido (uma linha por item)
  const groups = new Map();
  rows.slice(1).forEach((r, i) => {
    const get = (f) => (col[f] === undefined ? undefined : (r[col[f]] ?? '').trim());
    const num = get('order_number');
    const key = num || `__linha_${i + 2}`;
    if (!groups.has(key)) groups.set(key, { lines: [], rows: [] });
    groups.get(key).lines.push(i + 2);
    groups.get(key).rows.push(get);
  });
  const now = nowIso();
  const batchId = Number(db.prepare('INSERT INTO import_batches(channel, filename, created_at, rows_total) VALUES (?,?,?,?)')
    .run(channel, filename || null, now, rows.length - 1).lastInsertRowid);
  const res = { lote: batchId, linhas: rows.length - 1, criados: 0, atualizados: 0, sem_alteracao: 0, erros: [], avisos: [] };
  for (const [num, g] of groups) {
    try {
      const first = g.rows[0];
      // extratos (ex.: Mercado Livre) trazem tarifas como valor negativo: taxas, frete e descontos entram pelo valor absoluto
      const sumMoney = (f) => {
        const vals = g.rows.map((get) => get(f)).filter((v) => v !== undefined && v !== '');
        if (!vals.length) return undefined;
        const tot = vals.reduce((s, v) => s + parseMoney(v, colName(f), { allowNegative: true }), 0);
        return (f === 'net' ? tot : Math.abs(tot)) / 100;
      };
      const statuses = new Set(g.rows.map((get) => mapStatus(get('status'))));
      if (statuses.size > 1) throw new ValidationError('Linhas do mesmo pedido com status diferentes.', 'status');
      const payoutVals = g.rows.map((get) => get('payout_date')).filter(Boolean);
      // reimportação não apaga o que você ajustou à mão: repasse, observação e "voltou ao estoque" só mudam se o arquivo trouxer
      const prev = num.startsWith('__linha_') ? null : one(db, 'SELECT * FROM online_orders WHERE channel=? AND order_number=?', channel, num);
      const noteVal = first('note');
      const data = normalizeOrder(db, {
        channel, order_number: num.startsWith('__linha_') ? '' : num,
        date: first('date'), status: [...statuses][0],
        items: g.rows.map((get) => ({ sku: get('sku'), qty: get('qty'), unit_price: get('unit_price') || 0, product_name: get('product_name') })),
        gross: sumMoney('gross'), fees: sumMoney('fees') ?? 0, shipping: sumMoney('shipping') ?? 0,
        discount: sumMoney('discount') ?? 0, net: col.net === undefined ? undefined : sumMoney('net'),
        payout_date: payoutVals[0] || prev?.payout_date || null,
        note: noteVal || prev?.note || null,
        restock_on_return: prev ? prev.restock_on_return : undefined,
      });
      const r = tx(db, () => upsertOrder(db, data, { source: 'importacao', batchId }));
      if (r.action === 'criado') res.criados++; else if (r.action === 'atualizado') res.atualizados++; else res.sem_alteracao++;
      for (const it of data.items) if (!it.product_id) res.avisos.push(`Pedido ${num}: SKU "${it.sku}" não está cadastrado — o estoque não foi baixado para esse item.`);
    } catch (e) {
      if (!(e instanceof ValidationError) && !(e instanceof HttpError)) throw e;
      res.erros.push({ linhas: g.lines, pedido: num.startsWith('__linha_') ? '(sem número)' : num, erro: e.message });
    }
  }
  db.prepare('UPDATE import_batches SET created_orders=?, updated_orders=?, unchanged_orders=?, errors_json=? WHERE id=?')
    .run(res.criados, res.atualizados, res.sem_alteracao, JSON.stringify(res.erros), batchId);
  audit(db, 'importar', 'pedido_online', null, undefined, { canal: channel, arquivo: filename, ...res });
  return res;
}

const colName = (f) => ({ gross: 'valor bruto', fees: 'taxas', shipping: 'frete', discount: 'descontos', net: 'valor líquido' }[f] || f);

export default function online(db) {
  const r = Router();

  r.get('/online', h((req) => {
    const ini = req.query.inicio ? parseDate(req.query.inicio, 'data inicial') : '0000-01-01';
    const fim = req.query.fim ? parseDate(req.query.fim, 'data final') : '9999-12-31';
    const canal = req.query.canal ? oneOf(req.query.canal, CHANNEL_KEYS, 'canal') : null;
    const st = req.query.status ? oneOf(req.query.status, STATUSES, 'status') : null;
    const rows = all(db, `SELECT * FROM online_orders WHERE date BETWEEN ? AND ? AND (? IS NULL OR channel=?) AND (? IS NULL OR status=?)
                          ORDER BY date DESC, id DESC LIMIT 5000`, ini, fim, canal, canal, st, st);
    const its = db.prepare('SELECT * FROM online_order_items WHERE order_id=? ORDER BY id');
    for (const o of rows) o.items = its.all(o.id).map((x) => ({ ...x }));
    return rows;
  }));

  r.get('/online/modelo.csv', (req, res) => {
    const csv = toCsv(['pedido', 'data', 'sku', 'produto', 'quantidade', 'preco unitario', 'valor bruto', 'taxas', 'frete', 'desconto', 'valor liquido', 'status', 'data do repasse', 'observacao'], [
      ['2000012345', '10/09/2026', 'FEB-001', 'Fita Extenda Bonde', '1', '16,14', '16,14', '2,74', '6,25', '0,00', '7,15', 'entregue', '24/09/2026', ''],
      ['2000012399', '11/09/2026', 'PC-050', 'Prótese Capilar 50% Grisalho', '1', '581,22', '581,22', '87,18', '22,55', '0,00', '471,49', 'enviado', '', 'exemplo — apague estas linhas'],
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="modelo-importacao-pedidos.csv"');
    res.send(csv);
  });

  r.get('/online/lotes', h(() => all(db, 'SELECT * FROM import_batches ORDER BY id DESC LIMIT 50')));

  r.get('/online/:id', h((req) => loadOrder(db, parseId(req.params.id)) ?? (() => { throw notFound('Pedido'); })()));

  r.post('/online', h((req) => tx(db, () => {
    const data = normalizeOrder(db, req.body);
    const out = upsertOrder(db, data, { source: 'manual', allowUpdate: false });
    return loadOrder(db, out.id);
  })));

  r.put('/online/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const cur = loadOrder(db, id);
    if (!cur) throw notFound('Pedido');
    const data = normalizeOrder(db, { ...req.body, channel: cur.channel, order_number: cur.order_number });
    upsertOrder(db, data, { source: 'manual' });
    return loadOrder(db, id);
  })));

  r.post('/online/importar', h((req) => {
    const csv = req.body.csv;
    if (typeof csv !== 'string' || !csv.trim()) throw new ValidationError('Selecione um arquivo CSV.', 'arquivo');
    return importCsv(db, { channel: req.body.channel, filename: text(req.body.filename, 'nome do arquivo', { max: 200 }), csv });
  }));

  return r;
}
