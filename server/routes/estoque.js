import { Router } from 'express';
import { h, notFound } from '../http.js';
import { tx, audit, nowIso, all, one } from '../db.js';
import { text, parseMoney, parseDate, parseId, parseInt0, todaySP, ValidationError } from '../validate.js';
import { balances, addMovement, balanceOf, requireProduct } from '../services/stock.js';
import { linkOrphanItems } from './online.js';

function productFields(body, before = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : before[k]);
  const sku = pick('sku', (v) => text(v, 'SKU', { required: true, max: 40 })?.toUpperCase());
  if (sku && !/^[A-Z0-9][A-Z0-9._\-/]*$/.test(sku)) throw new ValidationError('SKU só pode ter letras, números, ponto, traço ou barra.', 'sku');
  const out = {
    sku,
    name: pick('name', (v) => text(v, 'nome do produto', { required: true, max: 120 })),
    category: pick('category', (v) => text(v, 'categoria', { max: 60 })),
    cost_cents: body.cost !== undefined ? parseMoney(body.cost, 'custo', { required: false }) : (before.cost_cents ?? 0),
    price_cents: body.price !== undefined ? parseMoney(body.price, 'preço de venda', { required: false }) : (before.price_cents ?? 0),
    min_stock: body.min_stock !== undefined ? parseInt0(body.min_stock, 'estoque mínimo', { min: 0, required: false }) ?? 0 : (before.min_stock ?? 0),
    supplier: pick('supplier', (v) => text(v, 'fornecedor', { max: 120 })),
    notes: pick('notes', (v) => text(v, 'observações', { max: 1000 })),
    active: body.active !== undefined ? (body.active ? 1 : 0) : (before.active ?? 1),
  };
  // Se o proprietário informou/confirmou o preço ou o custo, tira a marcação de "não confirmado"
  out.price_pending = body.price !== undefined || body.price_confirmado ? 0 : (before.price_pending ?? 0);
  out.cost_pending = body.cost !== undefined || body.custo_confirmado ? 0 : (before.cost_pending ?? 0);
  for (const k of Object.keys(out)) if (out[k] === undefined) out[k] = null;
  if (!out.sku) throw new ValidationError('Informe o SKU.', 'sku');
  if (!out.name) throw new ValidationError('Informe o nome do produto.', 'name');
  return out;
}

export default function estoque(db) {
  const r = Router();

  r.get('/produtos', h((req) => {
    const rows = balances(db);
    return req.query.todos ? rows : rows.filter((p) => p.active);
  }));

  r.get('/produtos/:id', h((req) => {
    const p = one(db, 'SELECT * FROM products WHERE id=?', parseId(req.params.id));
    if (!p) throw notFound('Produto');
    p.saldo = balanceOf(db, p.id);
    p.movimentacoes = all(db, 'SELECT * FROM stock_movements WHERE product_id=? ORDER BY date DESC, id DESC LIMIT 500', p.id);
    return p;
  }));

  r.post('/produtos', h((req) => tx(db, () => {
    const f = productFields(req.body);
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO products(sku, name, category, cost_cents, price_cents, min_stock, supplier, notes,
        cost_pending, price_pending, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.sku, f.name, f.category, f.cost_cents, f.price_cents, f.min_stock, f.supplier, f.notes, 0, 0, f.active, now, now).lastInsertRowid);
    const inicial = req.body.estoque_inicial !== undefined && req.body.estoque_inicial !== ''
      ? parseInt0(req.body.estoque_inicial, 'estoque inicial', { min: 0 }) : 0;
    if (inicial > 0) addMovement(db, { product_id: id, date: todaySP(), kind: 'saldo_inicial', qty: inicial, unit_cost_cents: f.cost_cents, note: 'Saldo inicial no cadastro' });
    const row = one(db, 'SELECT * FROM products WHERE id=?', id);
    const ligados = linkOrphanItems(db, row); // pedidos online que já tinham chegado com este SKU
    audit(db, 'criar', 'produto', id, undefined, { ...row, estoque_inicial: inicial, pedidos_ligados: ligados });
    return { ...row, saldo: balanceOf(db, id), pedidos_ligados: ligados };
  })));

  r.put('/produtos/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = one(db, 'SELECT * FROM products WHERE id=?', id);
    if (!before) throw notFound('Produto');
    const f = productFields(req.body, before);
    db.prepare(`UPDATE products SET sku=?, name=?, category=?, cost_cents=?, price_cents=?, min_stock=?, supplier=?, notes=?,
        cost_pending=?, price_pending=?, active=?, updated_at=? WHERE id=?`)
      .run(f.sku, f.name, f.category, f.cost_cents, f.price_cents, f.min_stock, f.supplier, f.notes, f.cost_pending, f.price_pending, f.active, nowIso(), id);
    const after = one(db, 'SELECT * FROM products WHERE id=?', id);
    if (after.sku.toUpperCase() !== before.sku.toUpperCase()) linkOrphanItems(db, after);
    audit(db, 'editar', 'produto', id, before, after);
    return { ...after, saldo: balanceOf(db, id) };
  })));

  // Compra / reposição: entrada separada no estoque (opcionalmente já registra a saída de caixa)
  r.post('/estoque/entrada', h((req) => tx(db, () => {
    const p = requireProduct(db, parseId(req.body.product_id, 'o produto'));
    const qty = parseInt0(req.body.qty, 'quantidade');
    const cost = parseMoney(req.body.unit_cost ?? p.cost_cents / 100, 'custo unitário', { required: false });
    const date = parseDate(req.body.date ?? todaySP(), 'data da compra');
    const note = text(req.body.note, 'observação', { max: 500 });
    addMovement(db, { product_id: p.id, date, kind: 'compra', qty, unit_cost_cents: cost, source: 'manual', note });
    let saida = null;
    if (req.body.registrar_saida) {
      const total = cost * qty;
      if (total <= 0) throw new ValidationError('Para registrar a saída de caixa, informe o custo unitário.', 'unit_cost');
      const now = nowIso();
      const sid = Number(db.prepare(`INSERT INTO cash_outs(date, description, category, amount_cents, payment_method, responsible, note, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,'ativo',?,?)`)
        .run(date, `Compra de estoque: ${qty}× ${p.sku} ${p.name}`, 'Compra de estoque', total,
          text(req.body.payment_method, 'forma de pagamento', { max: 60 }), text(req.body.responsible, 'responsável', { max: 60 }),
          note, now, now).lastInsertRowid);
      saida = one(db, 'SELECT * FROM cash_outs WHERE id=?', sid);
      audit(db, 'criar', 'saida', sid, undefined, saida);
    }
    audit(db, 'entrada', 'estoque', p.id, undefined, { qty, cost, date, note, saida_id: saida?.id });
    return { saldo: balanceOf(db, p.id), saida };
  })));

  // Ajuste de inventário (contagem, perda, quebra): exige motivo
  r.post('/estoque/ajuste', h((req) => tx(db, () => {
    const p = requireProduct(db, parseId(req.body.product_id, 'o produto'));
    const qty = parseInt0(req.body.qty, 'quantidade do ajuste', { min: -100000 });
    if (qty === 0) throw new ValidationError('O ajuste não pode ser zero.', 'qty');
    const date = parseDate(req.body.date ?? todaySP(), 'data do ajuste');
    const note = text(req.body.note, 'motivo do ajuste', { required: true, max: 500 });
    addMovement(db, { product_id: p.id, date, kind: 'ajuste', qty, source: 'manual', note });
    audit(db, 'ajuste', 'estoque', p.id, undefined, { qty, date, note });
    return { saldo: balanceOf(db, p.id) };
  })));

  return r;
}
