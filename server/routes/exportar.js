import { Router } from 'express';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { all, audit } from '../db.js';
import { todaySP } from '../validate.js';
import { toCsv } from '../services/csv.js';
import { notFound } from '../http.js';

const brl = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));
const brDate = (d) => (d ? d.split('-').reverse().join('/') : '');

// Tabelas exportáveis em CSV (abre no Excel/Google Planilhas)
const EXPORTS = {
  atendimentos: {
    sql: `SELECT a.id, a.date, b.name barbeiro, a.payment_method, a.subtotal_cents, a.discount_cents, a.total_cents, a.received_cents,
                 a.card_fee_cents, a.commission_pct, a.commission_cents, a.status, a.note,
                 (SELECT group_concat(service_name || ' (' || printf('%.2f', price_cents/100.0) || ')', ' + ') FROM appointment_items i WHERE i.appointment_id=a.id) servicos
          FROM appointments a JOIN barbers b ON b.id=a.barber_id ORDER BY a.date, a.id`,
    cols: [['ID', 'id'], ['Data', 'date', brDate], ['Barbeiro', 'barbeiro'], ['Serviços', 'servicos'], ['Pagamento', 'payment_method'],
      ['Subtotal', 'subtotal_cents', brl], ['Desconto', 'discount_cents', brl], ['Total', 'total_cents', brl], ['Recebido', 'received_cents', brl],
      ['Taxa maquininha', 'card_fee_cents', brl], ['% comissão', 'commission_pct'], ['Comissão', 'commission_cents', brl], ['Status', 'status'], ['Obs.', 'note']],
  },
  balcao: {
    sql: `SELECT v.id, v.date, i.sku, i.product_name, i.qty, i.unit_price_cents, v.discount_cents, v.total_cents, v.received_cents, v.payment_method,
                 b.name vendedor, v.status, v.note
          FROM counter_sales v JOIN counter_sale_items i ON i.sale_id=v.id LEFT JOIN barbers b ON b.id=v.seller_barber_id ORDER BY v.date, v.id`,
    cols: [['Venda', 'id'], ['Data', 'date', brDate], ['SKU', 'sku'], ['Produto', 'product_name'], ['Qtd', 'qty'], ['Preço unit.', 'unit_price_cents', brl],
      ['Desconto (venda)', 'discount_cents', brl], ['Total (venda)', 'total_cents', brl], ['Recebido (venda)', 'received_cents', brl], ['Pagamento', 'payment_method'],
      ['Responsável', 'vendedor'], ['Status', 'status'], ['Obs.', 'note']],
  },
  online: {
    sql: `SELECT o.*, i.sku, i.product_name, i.qty, i.unit_price_cents FROM online_orders o JOIN online_order_items i ON i.order_id=o.id ORDER BY o.date, o.id`,
    cols: [['Canal', 'channel'], ['Pedido', 'order_number'], ['Data', 'date', brDate], ['Status', 'status'], ['SKU', 'sku'], ['Produto', 'product_name'],
      ['Qtd', 'qty'], ['Preço unit.', 'unit_price_cents', brl], ['Bruto (pedido)', 'gross_cents', brl], ['Taxas', 'fees_cents', brl],
      ['Frete', 'shipping_cents', brl], ['Descontos', 'discount_cents', brl], ['Líquido', 'net_cents', brl], ['Repasse', 'payout_date', brDate], ['Obs.', 'note']],
  },
  produtos: {
    sql: `SELECT p.*, COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.product_id=p.id),0) saldo FROM products p ORDER BY p.sku`,
    cols: [['SKU', 'sku'], ['Produto', 'name'], ['Categoria', 'category'], ['Custo', 'cost_cents', brl], ['Preço', 'price_cents', brl],
      ['Saldo', 'saldo'], ['Mínimo', 'min_stock'], ['Ativo', 'active'], ['Preço a confirmar', 'price_pending'], ['Custo a confirmar', 'cost_pending']],
  },
  movimentacoes: {
    sql: `SELECT m.*, p.sku, p.name FROM stock_movements m JOIN products p ON p.id=m.product_id ORDER BY m.date, m.id`,
    cols: [['Data', 'date', brDate], ['SKU', 'sku'], ['Produto', 'name'], ['Tipo', 'kind'], ['Qtd', 'qty'], ['Origem', 'source'], ['Obs.', 'note']],
  },
  contas: {
    sql: 'SELECT * FROM payables ORDER BY due_date',
    cols: [['Vencimento', 'due_date', brDate], ['Descrição', 'description'], ['Fornecedor', 'supplier'], ['Categoria', 'category'], ['Valor', 'amount_cents', brl],
      ['Status', 'status'], ['Pago em', 'paid_date', brDate], ['Forma', 'payment_method'], ['A confirmar', 'needs_review'], ['Obs.', 'note']],
  },
  saidas: {
    sql: 'SELECT * FROM cash_outs ORDER BY date, id',
    cols: [['Data', 'date', brDate], ['Descrição', 'description'], ['Categoria', 'category'], ['Valor', 'amount_cents', brl], ['Forma', 'payment_method'],
      ['Responsável', 'responsible'], ['Conta vinculada', 'payable_id'], ['Status', 'status'], ['A confirmar', 'needs_review'], ['Obs.', 'note']],
  },
};

export default function exportar(db) {
  const r = Router();

  r.get('/exportar/:tabela.csv', (req, res, next) => {
    try {
      const e = Object.hasOwn(EXPORTS, req.params.tabela) ? EXPORTS[req.params.tabela] : null;
      if (!e) throw notFound('Relatório');
      const rows = all(db, e.sql).map((row) => e.cols.map(([, k, fmt]) => (fmt ? fmt(row[k]) : row[k])));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="verdugo-${req.params.tabela}-${todaySP()}.csv"`);
      res.send(toCsv(e.cols.map(([t]) => t), rows));
    } catch (err) { next(err); }
  });

  // Cópia completa do banco (para restaurar exatamente como estava)
  r.get('/exportar/backup.sqlite', (req, res, next) => {
    const dir = mkdtempSync(join(tmpdir(), 'verdugo-bkp-'));
    try {
      const file = join(dir, 'backup.sqlite');
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const buf = readFileSync(file);
      audit(db, 'backup', 'banco', null, undefined, { bytes: buf.length });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="verdugo-backup-${todaySP()}.sqlite"`);
      res.send(buf);
    } catch (err) { next(err); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  return r;
}
