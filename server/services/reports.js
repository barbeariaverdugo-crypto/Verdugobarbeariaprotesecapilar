import { all, one } from '../db.js';
import { todaySP, addDays } from '../validate.js';

export const CHANNELS = {
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
  tiktok_shop: 'TikTok Shop',
  amazon: 'Amazon',
};
const ACTIVE = "('pago','enviado','entregue')";

/**
 * Relatório de um período. Separa:
 *  - VENDA (pela data da venda): bruto, descontos, taxas, líquido;
 *  - CAIXA (pela data em que o dinheiro entrou): serviços/balcão na data do lançamento, online na data do REPASSE;
 *  - SAÍDAS (cada gasto individual, incluindo contas pagas — cada conta paga entra uma única vez).
 */
export function periodReport(db, start, end) {
  const s = one(db, `SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents),0) bruto, COALESCE(SUM(discount_cents),0) desconto,
                            COALESCE(SUM(total_cents),0) total, COALESCE(SUM(received_cents),0) recebido,
                            COALESCE(SUM(card_fee_cents),0) taxa, COALESCE(SUM(commission_cents),0) comissao
                     FROM appointments WHERE status='ativo' AND date BETWEEN ? AND ?`, start, end);
  const sCanc = one(db, `SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) valor FROM appointments
                         WHERE status='cancelado' AND date BETWEEN ? AND ?`, start, end);
  const porBarbeiro = all(db, `SELECT b.id, b.name, b.active, COUNT(a.id) atendimentos,
                                      COALESCE(SUM(a.subtotal_cents),0) bruto, COALESCE(SUM(a.total_cents),0) total,
                                      COALESCE(SUM(a.received_cents),0) recebido, COALESCE(SUM(a.commission_cents),0) comissao
                               FROM barbers b LEFT JOIN appointments a
                                 ON a.barber_id = b.id AND a.status='ativo' AND a.date BETWEEN ? AND ?
                               GROUP BY b.id ORDER BY total DESC, b.name`, start, end)
    .filter((r) => r.active || r.atendimentos > 0);

  const c = one(db, `SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents),0) bruto, COALESCE(SUM(discount_cents),0) desconto,
                            COALESCE(SUM(total_cents),0) total, COALESCE(SUM(received_cents),0) recebido,
                            COALESCE(SUM(card_fee_cents),0) taxa
                     FROM counter_sales WHERE status='ativo' AND date BETWEEN ? AND ?`, start, end);
  const cCanc = one(db, `SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) valor FROM counter_sales
                         WHERE status='cancelado' AND date BETWEEN ? AND ?`, start, end);
  const cItens = one(db, `SELECT COALESCE(SUM(i.qty),0) q FROM counter_sale_items i JOIN counter_sales v ON v.id=i.sale_id
                          WHERE v.status='ativo' AND v.date BETWEEN ? AND ?`, start, end).q;
  const porVendedor = all(db, `SELECT COALESCE(b.name,'(sem responsável)') name, COUNT(v.id) vendas, SUM(v.total_cents) total
                               FROM counter_sales v LEFT JOIN barbers b ON b.id = v.seller_barber_id
                               WHERE v.status='ativo' AND v.date BETWEEN ? AND ? GROUP BY v.seller_barber_id, b.name ORDER BY total DESC`, start, end);

  // dinheiro só "entrou" se a data do repasse já chegou (repasse futuro = ainda a receber)
  const hoje = todaySP();
  const caixaFim = end < hoje ? end : hoje;
  const canais = Object.entries(CHANNELS).map(([key, label]) => {
    const v = one(db, `SELECT COUNT(*) n, COALESCE(SUM(gross_cents),0) bruto, COALESCE(SUM(fees_cents),0) taxas,
                              COALESCE(SUM(shipping_cents),0) frete, COALESCE(SUM(discount_cents),0) desconto,
                              COALESCE(SUM(net_cents),0) liquido
                       FROM online_orders WHERE channel=? AND status IN ${ACTIVE} AND date BETWEEN ? AND ?`, key, start, end);
    const canc = one(db, `SELECT COUNT(*) n, COALESCE(SUM(gross_cents),0) bruto FROM online_orders
                          WHERE channel=? AND status='cancelado' AND date BETWEEN ? AND ?`, key, start, end);
    const dev = one(db, `SELECT COUNT(*) n, COALESCE(SUM(gross_cents),0) bruto FROM online_orders
                         WHERE channel=? AND status='devolvido' AND date BETWEEN ? AND ?`, key, start, end);
    const rep = one(db, `SELECT COUNT(*) n, COALESCE(SUM(net_cents),0) valor FROM online_orders
                         WHERE channel=? AND status IN ${ACTIVE} AND payout_date BETWEEN ? AND ?`, key, start, caixaFim);
    const aReceber = one(db, `SELECT COUNT(*) n, COALESCE(SUM(net_cents),0) valor FROM online_orders
                              WHERE channel=? AND status IN ${ACTIVE} AND date <= ? AND (payout_date IS NULL OR payout_date > ?)`, key, end, caixaFim);
    return { canal: key, nome: label, vendas: v, cancelados: canc, devolvidos: dev, repasses: rep, a_receber: aReceber };
  });
  const on = canais.reduce((a, k) => ({
    n: a.n + k.vendas.n, bruto: a.bruto + k.vendas.bruto, taxas: a.taxas + k.vendas.taxas, frete: a.frete + k.vendas.frete,
    desconto: a.desconto + k.vendas.desconto, liquido: a.liquido + k.vendas.liquido, repasses: a.repasses + k.repasses.valor,
    a_receber: a.a_receber + k.a_receber.valor,
  }), { n: 0, bruto: 0, taxas: 0, frete: 0, desconto: 0, liquido: 0, repasses: 0, a_receber: 0 });

  const saidas = one(db, `SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) total FROM cash_outs
                          WHERE status='ativo' AND needs_review=0 AND date BETWEEN ? AND ?`, start, end);
  const saidasCat = all(db, `SELECT COALESCE(category,'(sem categoria)') categoria, COUNT(*) n, SUM(amount_cents) total
                             FROM cash_outs WHERE status='ativo' AND needs_review=0 AND date BETWEEN ? AND ?
                             GROUP BY categoria ORDER BY total DESC`, start, end);
  const contasPagas = one(db, `SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) total FROM cash_outs
                               WHERE status='ativo' AND needs_review=0 AND payable_id IS NOT NULL AND date BETWEEN ? AND ?`, start, end);

  const venda = {
    bruto: s.bruto + c.bruto + on.bruto,
    descontos: s.desconto + c.desconto + on.desconto,
    taxas: s.taxa + c.taxa + on.taxas + on.frete,
    liquido: s.recebido + c.recebido + on.liquido,
  };
  const caixa = {
    servicos: s.recebido, balcao: c.recebido, repasses_online: on.repasses,
    entradas: s.recebido + c.recebido + on.repasses,
    saidas: saidas.total,
  };
  caixa.resultado = caixa.entradas - caixa.saidas;

  return {
    periodo: { inicio: start, fim: end },
    servicos: { ...s, cancelados: sCanc, por_barbeiro: porBarbeiro },
    balcao: { ...c, itens: cItens, cancelados: cCanc, por_vendedor: porVendedor },
    online: { ...on, canais },
    venda, caixa,
    saidas: { ...saidas, por_categoria: saidasCat, contas_pagas: contasPagas },
  };
}

export function alerts(db) {
  const today = todaySP();
  const lowStock = all(db, `SELECT p.id, p.sku, p.name, p.min_stock, COALESCE(SUM(m.qty),0) saldo
                            FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
                            WHERE p.active = 1 GROUP BY p.id HAVING COALESCE(SUM(m.qty),0) <= p.min_stock ORDER BY COALESCE(SUM(m.qty),0) - p.min_stock, p.name`);
  const vencidas = all(db, `SELECT * FROM payables WHERE status='pendente' AND needs_review=0 AND due_date < ? ORDER BY due_date`, today);
  const aVencer = all(db, `SELECT * FROM payables WHERE status='pendente' AND needs_review=0 AND due_date BETWEEN ? AND ? ORDER BY due_date`,
    today, addDays(today, 7));
  const revisar = {
    contas: one(db, 'SELECT COUNT(*) n FROM payables WHERE needs_review=1').n,
    saidas: one(db, 'SELECT COUNT(*) n FROM cash_outs WHERE needs_review=1').n,
    caixas: one(db, 'SELECT COUNT(*) n FROM cash_accounts WHERE needs_review=1').n,
    precos: one(db, 'SELECT COUNT(*) n FROM products WHERE active=1 AND (price_pending=1 OR cost_pending=1)').n,
    sku_desconhecido: one(db, 'SELECT COUNT(*) n FROM online_order_items WHERE product_id IS NULL').n,
  };
  return { hoje: today, estoque_baixo: lowStock, contas_vencidas: vencidas, contas_a_vencer: aVencer, revisar };
}

/** Saldo estimado de caixa e bancos: saldos iniciais confirmados + entradas − saídas desde a data inicial. */
export function cashPosition(db) {
  const accs = all(db, 'SELECT * FROM cash_accounts WHERE active=1 AND needs_review=0');
  if (!accs.length) return null;
  const since = accs.reduce((m, a) => (a.opening_date < m ? a.opening_date : m), accs[0].opening_date);
  const today = todaySP();
  const r = periodReport(db, since, today);
  const inicial = accs.reduce((t, a) => t + a.opening_cents, 0);
  return { desde: since, saldo_inicial: inicial, entradas: r.caixa.entradas, saidas: r.caixa.saidas,
    saldo_estimado: inicial + r.caixa.resultado, contas: accs.length };
}
