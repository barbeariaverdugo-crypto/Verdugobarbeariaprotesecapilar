import { nowIso, all, one } from '../db.js';
import { ValidationError } from '../validate.js';

export const ONLINE_ACTIVE = ['pago', 'enviado', 'entregue'];

/** Saldo atual de todos os produtos (soma das movimentações). */
export function balances(db) {
  return all(db, `SELECT p.*, COALESCE(SUM(m.qty), 0) AS saldo
                  FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
                  GROUP BY p.id ORDER BY p.category, p.name`);
}

export function balanceOf(db, productId) {
  return one(db, 'SELECT COALESCE(SUM(qty),0) AS s FROM stock_movements WHERE product_id = ?', productId).s;
}

export function productBySku(db, sku) {
  return one(db, 'SELECT * FROM products WHERE sku = ? COLLATE NOCASE', String(sku || '').trim());
}

export function addMovement(db, m) {
  if (!m.qty) return;
  db.prepare(`INSERT INTO stock_movements(product_id, date, kind, qty, unit_cost_cents, source, source_id, source_item_id, note, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(m.product_id, m.date, m.kind, m.qty, m.unit_cost_cents ?? null, m.source ?? 'manual',
      m.source_id ?? null, m.source_item_id ?? null, m.note ?? null, nowIso());
}

/**
 * Deixa o efeito de um item de venda no estoque igual ao "efeito desejado".
 * É idempotente: chamar duas vezes (ou reimportar o mesmo pedido) não baixa o estoque duas vezes,
 * porque compara com o que JÁ foi lançado para aquele item e só grava a diferença.
 */
export function syncItemStock(db, { source, sourceId, itemId, productId, desiredQty, date, reasonKind, saleKind, note }) {
  // Se este item já tinha movimentado OUTRO produto (ex.: o SKU passou a ser de outro cadastro), desfaz lá primeiro.
  const others = all(db, `SELECT product_id, SUM(qty) AS s FROM stock_movements WHERE source = ? AND source_item_id = ?
                          AND (? IS NULL OR product_id <> ?) GROUP BY product_id`, source, itemId, productId ?? null, productId ?? null);
  for (const o of others) {
    if (o.s !== 0) addMovement(db, { product_id: o.product_id, date, qty: -o.s, kind: 'estorno', source, source_id: sourceId,
      source_item_id: itemId, note: `${note ?? ''} — item passou para outro produto`.trim() });
  }
  if (!productId) return 0;
  const cur = one(db, 'SELECT COALESCE(SUM(qty),0) AS s FROM stock_movements WHERE source = ? AND source_item_id = ? AND product_id = ?',
    source, itemId, productId).s;
  const delta = desiredQty - cur;
  if (delta === 0) return 0;
  addMovement(db, {
    product_id: productId, date, qty: delta,
    kind: delta < 0 ? saleKind : reasonKind,
    source, source_id: sourceId, source_item_id: itemId, note,
  });
  return delta;
}

/** Efeito desejado de um pedido online no estoque, conforme o status. */
export function onlineDesiredQty(status, restockOnReturn, qty) {
  if (ONLINE_ACTIVE.includes(status)) return -qty;
  if (status === 'cancelado') return 0;                 // cancelou: volta tudo
  if (status === 'devolvido') return restockOnReturn ? 0 : -qty; // devolveu: volta se o produto retornou em condições
  return 0;
}

export function onlineReasonKind(status) {
  if (status === 'cancelado') return 'cancelamento';
  if (status === 'devolvido') return 'devolucao';
  return 'estorno';
}

/** Neutraliza o efeito de itens que foram removidos de uma venda (mantém o histórico). */
export function neutralizeRemovedItems(db, source, sourceId, keepItemIds, date, note) {
  const rows = all(db, `SELECT source_item_id, product_id, SUM(qty) AS s FROM stock_movements
                        WHERE source = ? AND source_id = ? GROUP BY source_item_id, product_id`, source, sourceId);
  for (const r of rows) {
    if (keepItemIds.includes(r.source_item_id) || r.s === 0) continue;
    addMovement(db, { product_id: r.product_id, date, qty: -r.s, kind: 'estorno', source, source_id: sourceId,
      source_item_id: r.source_item_id, note });
  }
}

export function requireProduct(db, productId) {
  const p = one(db, 'SELECT * FROM products WHERE id = ?', productId);
  if (!p) throw new ValidationError('Produto não encontrado.', 'produto');
  return p;
}
