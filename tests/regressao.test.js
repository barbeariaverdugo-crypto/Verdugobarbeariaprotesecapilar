// Testes de regressão para os defeitos encontrados na revisão independente.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ids } from './helpers.js';

let T, api, db, I;
before(async () => { T = await startApp(); api = T.api; db = T.db; I = ids(db); });
after(async () => { await T.close(); });

const HDR = 'pedido;data;sku;quantidade;preco unitario;taxas;status';

test('R1. reimportar não apaga repasse, observação nem "não voltou ao estoque" lançados à mão', async () => {
  const csv = `${HDR}\nR1-1;10/09/2026;MAX-001;1;150,00;20,00;entregue`;
  await api.post('/api/online/importar', { channel: 'shopee', filename: 'a.csv', csv });
  const o = (await api.get('/api/online?canal=shopee')).data.find((x) => x.order_number === 'R1-1');
  const s0 = I.saldo('MAX-001');
  await api.put(`/api/online/${o.id}`, { date: o.date, status: 'devolvido', restock_on_return: false, payout_date: '2026-09-20', note: 'cliente devolveu riscado',
    items: [{ sku: 'MAX-001', qty: 1, unit_price: '150,00' }], gross: '150,00', fees: '20,00' });
  assert.equal(I.saldo('MAX-001'), s0, 'devolvido sem retorno mantém a baixa');
  const csv2 = `${HDR}\nR1-1;10/09/2026;MAX-001;1;150,00;20,00;devolvido`;
  await api.post('/api/online/importar', { channel: 'shopee', filename: 'b.csv', csv: csv2 });
  const d = (await api.get(`/api/online/${o.id}`)).data;
  assert.equal(d.restock_on_return, 0);
  assert.equal(d.payout_date, '2026-09-20');
  assert.equal(d.note, 'cliente devolveu riscado');
  assert.equal(I.saldo('MAX-001'), s0, 'estoque não mudou na reimportação');
});

test('R2. SKU que chegou sem cadastro baixa o estoque quando o produto é cadastrado (uma vez só)', async () => {
  const csv = `${HDR}\nR2-1;12/09/2026;NOVO-9;2;30,00;3,00;pago`;
  const r = (await api.post('/api/online/importar', { channel: 'amazon', filename: 'n.csv', csv })).data;
  assert.equal(r.criados, 1);
  assert.ok(r.avisos[0].includes('NOVO-9'));
  const p = (await api.post('/api/produtos', { sku: 'novo-9', name: 'Produto novo', estoque_inicial: 10 })).data;
  assert.equal(p.pedidos_ligados, 1);
  assert.equal(I.saldo('NOVO-9'), 8);
  await api.post('/api/online/importar', { channel: 'amazon', filename: 'n.csv', csv });
  assert.equal(I.saldo('NOVO-9'), 8, 'reimportar não baixa de novo');
});

test('R3. porcentagem é sempre em %: "1" = 1%, "0,5" = 0,5%', async () => {
  const b = (await api.post('/api/barbeiros', { name: 'Teste Pct', commission_pct: '1' })).data;
  assert.equal(b.commission_pct, 0.01);
  const b2 = (await api.put(`/api/barbeiros/${b.id}`, { commission_pct: '0,5' })).data;
  assert.equal(b2.commission_pct, 0.005);
  assert.equal((await api.put(`/api/barbeiros/${b.id}`, { commission_pct: '150' })).status, 400);
});

test('R4. comissão fica congelada mesmo se a regra mudar depois', async () => {
  const a = (await api.post('/api/atendimentos', { date: '2026-09-15', barber_id: I.barber('Pedro'), payment_method: 'Pix',
    items: [{ service_id: I.service('Corte e Barba') }], discount: '50,00' })).data;
  assert.equal(a.commission_cents, 5000);
  await api.put('/api/configuracoes', { commission_base: 'apos_desconto' });
  const e = (await api.put(`/api/atendimentos/${a.id}`, { date: a.date, barber_id: a.barber_id, payment_method: 'Pix', discount: '50,00',
    items: a.items.map((i) => ({ id: i.id, service_id: i.service_id })), note: 'só mudei a observação' })).data;
  assert.equal(e.commission_cents, 5000, 'editar a observação não recalcula pela regra nova');
  const novo = (await api.post('/api/atendimentos', { date: '2026-09-15', barber_id: I.barber('Pedro'), payment_method: 'Pix',
    items: [{ service_id: I.service('Corte e Barba') }], discount: '50,00' })).data;
  assert.equal(novo.commission_cents, 2500, 'lançamento novo usa a regra nova');
  await api.put('/api/configuracoes', { commission_base: 'tabela' });
});

test('R5. repasse com data futura continua "a receber" e não entra no caixa', async () => {
  await api.post('/api/online', { channel: 'tiktok_shop', order_number: 'R5-1', date: '2026-09-20', status: 'entregue',
    items: [{ sku: 'SHD-001', qty: 1, unit_price: '100,00' }], payout_date: '2099-01-01' });
  const r = (await api.get('/api/relatorio?periodo=personalizado&inicio=2026-09-20&fim=2099-12-31')).data;
  const tt = r.online.canais.find((c) => c.canal === 'tiktok_shop');
  assert.equal(tt.repasses.valor, 0);
  assert.equal(tt.a_receber.valor, 10000);
});

test('R6. status negativo ("Não pago") é recusado na importação; tarifas negativas do extrato entram como taxa', async () => {
  const csv = `${HDR}\nR6-1;12/09/2026;SHD-001;1;75,00;-10,50;Não pago\nR6-2;12/09/2026;SHD-001;1;75,00;-10,50;Pronto para enviar`;
  const s0 = I.saldo('SHD-001');
  const r = (await api.post('/api/online/importar', { channel: 'mercado_livre', filename: 's.csv', csv })).data;
  assert.equal(r.criados, 1);
  assert.equal(r.erros[0].pedido, 'R6-1');
  assert.equal(I.saldo('SHD-001'), s0 - 1);
  const o = db.prepare("SELECT * FROM online_orders WHERE order_number='R6-2'").get();
  assert.equal(o.fees_cents, 1050);
  assert.equal(o.net_cents, 7500 - 1050);
});

test('R7. SKU passado para outro produto: estoque corrigido nos dois', async () => {
  const p1 = (await api.post('/api/produtos', { sku: 'TRK-A', name: 'Produto A', estoque_inicial: 5 })).data;
  const o = (await api.post('/api/online', { channel: 'shopee', order_number: 'R7-1', date: '2026-09-21', status: 'pago',
    items: [{ sku: 'TRK-A', qty: 1, unit_price: '10,00' }] })).data;
  assert.equal(I.saldo('TRK-A'), 4);
  await api.put(`/api/produtos/${p1.id}`, { sku: 'TRK-A-OLD' });
  await api.post('/api/produtos', { sku: 'TRK-A', name: 'Produto A novo', estoque_inicial: 5 });
  await api.put(`/api/online/${o.id}`, { date: o.date, status: 'pago', items: [{ sku: 'TRK-A', qty: 2, unit_price: '10,00' }] });
  assert.equal(I.saldo('TRK-A-OLD'), 5, 'o produto antigo recebeu de volta');
  assert.equal(I.saldo('TRK-A'), 3, 'o produto novo baixou 2');
});

test('R8. entradas estranhas não derrubam o servidor', async () => {
  const r1 = await fetch(`${T.base}/login`, { headers: { cookie: 'x=%zz; outro=1' } });
  assert.equal(r1.status, 200, 'cookie malformado de outro site não trava o login');
  assert.equal((await api.post('/api/balcao', { payment_method: 'Pix', items: [null] })).status, 400);
  assert.equal((await api.post('/api/online', { channel: 'amazon', order_number: 'Z', date: '2026-09-01', items: [null] })).status, 400);
  assert.equal((await api.post('/api/atendimentos', { barber_id: I.barber('Pedro'), payment_method: 'Pix', items: [null] })).status, 400);
  assert.equal((await api.get('/api/exportar/constructor.csv')).status, 404);
  assert.equal((await api.get('/api/auditoria?limite=0.5')).status, 400);
  assert.equal((await api.get('/api/auditoria?limite=-1')).status, 400);
  const saida = db.prepare('SELECT id FROM cash_outs WHERE payable_id IS NOT NULL AND needs_review=1 LIMIT 1').get();
  assert.equal((await api.post(`/api/saidas/${saida.id}/confirmar`)).status, 409, 'saída de conta-exemplo só se confirma pela conta');
  const csv = (await api.get('/api/exportar/saidas.csv')).data;
  assert.ok(!/;=|;\+|;@/.test(csv), 'CSV sem fórmulas injetadas');
});

test('R9. data com horário e fuso vira o dia certo em São Paulo', async () => {
  const csv = 'pedido;data;sku;quantidade;preco unitario;status\nR9-1;2026-09-10T01:30:00Z;SHD-001;1;75,00;pago';
  await api.post('/api/online/importar', { channel: 'amazon', filename: 't.csv', csv });
  assert.equal(db.prepare("SELECT date FROM online_orders WHERE order_number='R9-1'").get().date, '2026-09-09');
});
