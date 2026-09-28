// Testes obrigatórios (1–11, parte de API). Rodar com:  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ids } from './helpers.js';

let T, api, db, I;
before(async () => { T = await startApp(); api = T.api; db = T.db; I = ids(db); });
after(async () => { await T.close(); });

test('0. importação da planilha trouxe cadastros e marcou dados duvidosos', async () => {
  assert.equal(T.importRep.barbeiros, 3);
  assert.equal(T.importRep.servicos, 46);
  assert.equal(T.importRep.produtos, 47);
  assert.equal(I.saldo('FEB-001'), 302);
  const inicio = (await api.get('/api/inicio?periodo=mes&ref=2026-09-15')).data;
  assert.ok(inicio.alertas.revisar.contas >= 6, 'contas-exemplo aparecem como "a confirmar"');
  assert.equal(inicio.caixa, null, 'saldos de banco que parecem exemplo NÃO entram no caixa até serem confirmados');
  assert.ok(inicio.alertas.revisar.precos > 0, 'produtos com preço zerado ficam sinalizados');
});

test('1. atendimento com serviço principal + vários adicionais calcula certo', async () => {
  const body = {
    date: '2026-09-14', barber_id: I.barber('Pedro'), payment_method: 'Cartão de Crédito',
    items: [
      { service_id: I.service('Corte'), is_main: true },            // 55,00 (preço do catálogo)
      { service_id: I.service('Barba') },                            // 45,00
      { service_id: I.service('Sombrancelha'), price: '30,00' },     // preço praticado diferente do catálogo (35)
    ],
    discount: '10,00', received: '115,50', note: 'cliente fiel',
  };
  const r = await api.post('/api/atendimentos', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = r.data;
  assert.equal(a.items.length, 3);
  assert.equal(a.items.filter((i) => i.is_main).length, 1);
  assert.equal(a.items[0].service_name, 'Corte');
  assert.equal(a.subtotal_cents, 13000);         // 55 + 45 + 30
  assert.equal(a.discount_cents, 1000);
  assert.equal(a.total_cents, 12000);
  assert.equal(a.received_cents, 11550);
  assert.equal(a.card_fee_cents, 450);           // taxa da maquininha
  assert.equal(a.commission_cents, 6500);        // 50% sobre o valor dos serviços (regra da planilha)
  // mudar o preço do catálogo NÃO altera o atendimento já lançado
  await api.put(`/api/servicos/${I.service('Corte')}`, { price: '70,00' });
  const again = (await api.get(`/api/atendimentos/${a.id}`)).data;
  assert.equal(again.items.find((i) => i.service_name === 'Corte').price_cents, 5500);
  assert.equal(again.subtotal_cents, 13000);
  await api.put(`/api/servicos/${I.service('Corte')}`, { price: '55,00' });
});

test('2. barbeiro novo aparece nos lançamentos e nos relatórios', async () => {
  const nb = await api.post('/api/barbeiros', { name: 'Lucas', commission_pct: '40' });
  assert.equal(nb.status, 200);
  const lista = (await api.get('/api/barbeiros')).data.map((b) => b.name);
  assert.ok(lista.includes('Lucas'));
  const at = await api.post('/api/atendimentos', { date: '2026-09-15', barber_id: nb.data.id, payment_method: 'Pix',
    items: [{ service_id: I.service('Corte'), is_main: true }] });
  assert.equal(at.status, 200);
  assert.equal(at.data.commission_cents, 2200);  // 40% de 55
  const rep = (await api.get('/api/relatorio?periodo=mes&ref=2026-09-15')).data;
  const linha = rep.servicos.por_barbeiro.find((b) => b.name === 'Lucas');
  assert.ok(linha && linha.atendimentos === 1 && linha.comissao === 2200);
  // desativar não apaga o histórico
  await api.put(`/api/barbeiros/${nb.data.id}`, { active: false });
  const rep2 = (await api.get('/api/relatorio?periodo=mes&ref=2026-09-15')).data;
  assert.ok(rep2.servicos.por_barbeiro.find((b) => b.name === 'Lucas'));
  assert.ok(!(await api.get('/api/barbeiros')).data.find((b) => b.name === 'Lucas'), 'desativado some da lista de lançamento');
});

test('3. anotações ficam ligadas ao barbeiro selecionado', async () => {
  const pedro = I.barber('Pedro'); const andre = I.barber('André');
  await api.post(`/api/barbeiros/${pedro}/anotacoes`, { text: 'Pedro: pediu folga dia 20' });
  await api.post(`/api/barbeiros/${andre}/anotacoes`, { text: 'André: meta de 30 cortes' });
  const np = (await api.get(`/api/barbeiros/${pedro}/anotacoes`)).data;
  const na = (await api.get(`/api/barbeiros/${andre}/anotacoes`)).data;
  assert.deepEqual(np.map((n) => n.text), ['Pedro: pediu folga dia 20']);
  assert.deepEqual(na.map((n) => n.text), ['André: meta de 30 cortes']);
  // sem login não dá para ler anotações
  const anon = await T.anon.get(`/api/barbeiros/${pedro}/anotacoes`);
  assert.equal(anon.status, 401);
});

test('4. venda de balcão baixa o MESMO estoque que as vendas online (por SKU)', async () => {
  const s0 = I.saldo('ARG-001');
  const v = await api.post('/api/balcao', { date: '2026-09-16', payment_method: 'Pix', items: [{ sku: 'arg-001', qty: 2 }] });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(v.data.seller_barber_id, null, 'responsável é opcional');
  assert.equal(I.saldo('ARG-001'), s0 - 2);
  const o = await api.post('/api/online', { channel: 'shopee', order_number: 'SHP-1', date: '2026-09-16', status: 'pago',
    items: [{ sku: 'ARG-001', qty: 1, unit_price: '60,00' }], fees: '8,20', net: '51,80' });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  assert.equal(I.saldo('ARG-001'), s0 - 3);
  // cancelar a venda de balcão devolve ao estoque
  await api.post(`/api/balcao/${v.data.id}/cancelar`);
  assert.equal(I.saldo('ARG-001'), s0 - 1);
  await api.post(`/api/balcao/${v.data.id}/reativar`);
  assert.equal(I.saldo('ARG-001'), s0 - 3);
});

test('5. os quatro canais aparecem separados nos relatórios', async () => {
  const pedidos = [
    ['mercado_livre', 'ML-100', '581,22', '87,18', '22,55'],
    ['shopee', 'SHP-100', '663,50', '97,88', '0'],
    ['tiktok_shop', 'TT-100', '100,00', '12,00', '5,00'],
    ['amazon', 'AMZ-100', '200,00', '30,00', '0'],
  ];
  for (const [channel, num, gross, fees, ship] of pedidos) {
    const r = await api.post('/api/online', { channel, order_number: num, date: '2026-09-17', status: 'entregue',
      items: [{ sku: 'SHD-001', qty: 1 }], gross, fees, shipping: ship });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const rep = (await api.get('/api/relatorio?periodo=personalizado&inicio=17/09/2026&fim=17/09/2026')).data;
  const by = Object.fromEntries(rep.online.canais.map((c) => [c.canal, c.vendas]));
  assert.equal(by.mercado_livre.bruto, 58122);
  assert.equal(by.mercado_livre.liquido, 58122 - 8718 - 2255);
  assert.equal(by.shopee.bruto, 66350);
  assert.equal(by.tiktok_shop.bruto, 10000);
  assert.equal(by.amazon.bruto, 20000);
  assert.equal(rep.online.canais.map((c) => c.nome).join('|'), 'Mercado Livre|Shopee|TikTok Shop|Amazon');
});

test('6. reimportar o mesmo pedido não duplica venda nem baixa de estoque', async () => {
  const csv = [
    'pedido;data;sku;quantidade;preco unitario;taxas;frete;valor liquido;status;data do repasse',
    '2000099;10/09/2026;FEB-001;3;16,14;8,23;6,25;33,94;entregue;',
    '2000100;11/09/2026;MAS-001;1;85,00;12,75;0;72,25;pago;',
  ].join('\n');
  const s0 = I.saldo('FEB-001');
  const r1 = (await api.post('/api/online/importar', { channel: 'mercado_livre', filename: 'vendas.csv', csv })).data;
  assert.equal(r1.criados, 2);
  assert.equal(I.saldo('FEB-001'), s0 - 3);
  const r2 = (await api.post('/api/online/importar', { channel: 'mercado_livre', filename: 'vendas.csv', csv })).data;
  assert.equal(r2.criados, 0);
  assert.equal(r2.sem_alteracao, 2);
  assert.equal(I.saldo('FEB-001'), s0 - 3, 'estoque não foi baixado de novo');
  const n = db.prepare("SELECT COUNT(*) n FROM online_orders WHERE order_number IN ('2000099','2000100')").get().n;
  assert.equal(n, 2);
  // reimportação com o repasse preenchido ATUALIZA o pedido (sem duplicar)
  const csv3 = csv.replace('entregue;', 'entregue;12/09/2026');
  const r3 = (await api.post('/api/online/importar', { channel: 'mercado_livre', filename: 'vendas2.csv', csv: csv3 })).data;
  assert.equal(r3.atualizados, 1);
  assert.equal(I.saldo('FEB-001'), s0 - 3);
  // o mesmo número em OUTRO canal é outro pedido
  const r4 = (await api.post('/api/online/importar', { channel: 'amazon', filename: 'amz.csv', csv })).data;
  assert.equal(r4.criados, 2);
});

test('7. pedido cancelado/devolvido segue a regra de estoque e continua nos relatórios', async () => {
  const s0 = I.saldo('MAX-001');
  const o = (await api.post('/api/online', { channel: 'mercado_livre', order_number: 'ML-CANC', date: '2026-09-18', status: 'pago',
    items: [{ sku: 'MAX-001', qty: 2, unit_price: '150,00' }], fees: '45,00' })).data;
  assert.equal(I.saldo('MAX-001'), s0 - 2);
  await api.put(`/api/online/${o.id}`, { ...o, status: 'cancelado', items: o.items.map((i) => ({ sku: i.sku, qty: i.qty, unit_price: i.unit_price_cents / 100 })),
    gross: o.gross_cents / 100, fees: o.fees_cents / 100, net: '' });
  assert.equal(I.saldo('MAX-001'), s0, 'cancelado: volta ao estoque');
  const kinds = db.prepare('SELECT kind, qty FROM stock_movements WHERE source=? AND source_id=? ORDER BY id').all('online', o.id).map((m) => `${m.kind}:${m.qty}`);
  assert.deepEqual(kinds, ['venda_online:-2', 'cancelamento:2'], 'histórico mostra a venda e o cancelamento');
  const rep = (await api.get('/api/relatorio?periodo=personalizado&inicio=2026-09-18&fim=2026-09-18')).data;
  const ml = rep.online.canais.find((c) => c.canal === 'mercado_livre');
  assert.equal(ml.cancelados.n, 1, 'o pedido cancelado aparece no relatório');
  assert.equal(ml.cancelados.bruto, 30000);
  assert.equal(ml.vendas.n, 0, 'mas não soma no faturamento');
  // devolução sem retorno ao estoque (produto danificado) mantém a baixa
  const d = (await api.post('/api/online', { channel: 'shopee', order_number: 'SHP-DEV', date: '2026-09-18', status: 'entregue',
    items: [{ sku: 'MAX-001', qty: 1, unit_price: '150,00' }] })).data;
  await api.put(`/api/online/${d.id}`, { status: 'devolvido', restock_on_return: false, date: d.date, items: [{ sku: 'MAX-001', qty: 1, unit_price: '150,00' }] });
  assert.equal(I.saldo('MAX-001'), s0 - 1);
  await api.put(`/api/online/${d.id}`, { status: 'devolvido', restock_on_return: true, date: d.date, items: [{ sku: 'MAX-001', qty: 1, unit_price: '150,00' }] });
  assert.equal(I.saldo('MAX-001'), s0, 'devolução com produto de volta: repõe');
  const rep2 = (await api.get('/api/relatorio?periodo=personalizado&inicio=2026-09-18&fim=2026-09-18')).data;
  assert.equal(rep2.online.canais.find((c) => c.canal === 'shopee').devolvidos.n, 1);
});

test('8. conta paga entra no caixa uma única vez', async () => {
  const c = (await api.post('/api/contas', { description: 'Energia elétrica', category: 'Utilidades', amount: '380,00', due_date: '2026-09-20' })).data;
  const p1 = await api.post(`/api/contas/${c.id}/pagar`, { paid_date: '2026-09-19', payment_method: 'Pix', responsible: 'Pedro' });
  assert.equal(p1.status, 200);
  const p2 = await api.post(`/api/contas/${c.id}/pagar`, { paid_date: '2026-09-19', payment_method: 'Pix' });
  assert.equal(p2.status, 409, 'pagar de novo é recusado');
  let n = db.prepare('SELECT COUNT(*) n FROM cash_outs WHERE payable_id=?').get(c.id).n;
  assert.equal(n, 1);
  // desfazer e pagar de novo continua sendo UMA saída
  await api.post(`/api/contas/${c.id}/desfazer-pagamento`);
  await api.post(`/api/contas/${c.id}/pagar`, { paid_date: '2026-09-19', payment_method: 'Pix' });
  n = db.prepare("SELECT COUNT(*) n FROM cash_outs WHERE payable_id=? AND status='ativo'").get(c.id).n;
  assert.equal(n, 1);
  const rep = (await api.get('/api/relatorio?periodo=personalizado&inicio=2026-09-19&fim=2026-09-19')).data;
  assert.equal(rep.caixa.saidas, 38000);
  assert.equal(rep.saidas.contas_pagas.n, 1);
  // contas-exemplo da planilha não podem ser pagas sem confirmação e não entram nas saídas
  const exemplo = db.prepare('SELECT id FROM payables WHERE needs_review=1 AND status=? LIMIT 1').get('pendente');
  assert.equal((await api.post(`/api/contas/${exemplo.id}/pagar`, {})).status, 409);
  const junho = (await api.get('/api/relatorio?periodo=mes&ref=2026-06-10')).data;
  assert.equal(junho.caixa.saidas, 0, 'aluguel-exemplo pago em junho não entra no caixa até ser confirmado');
});

test('9. fechamento semanal/mensal separa bruto, taxas, líquido e repasse', async () => {
  // semana 21–27/09/2026
  await api.post('/api/atendimentos', { date: '2026-09-22', barber_id: I.barber('André'), payment_method: 'Cartão de Débito',
    items: [{ service_id: I.service('Corte e Barba'), is_main: true }], received: '97,00' });
  await api.post('/api/online', { channel: 'mercado_livre', order_number: 'ML-SEM', date: '2026-09-22', status: 'entregue',
    items: [{ sku: 'PC-003', qty: 1, unit_price: '950,00' }], fees: '142,50', shipping: '22,55' });           // repasse ainda não caiu
  await api.post('/api/online', { channel: 'shopee', order_number: 'SHP-OLD', date: '2026-09-10', status: 'entregue',
    items: [{ sku: 'SHD-001', qty: 1, unit_price: '75,00' }], fees: '10,00', payout_date: '2026-09-23' });   // venda antiga, repasse nesta semana
  await api.post('/api/saidas', { date: '2026-09-23', description: 'Café e copos', category: 'Suprimentos', amount: '42,90', responsible: 'André' });
  const f = await api.post('/api/fechamentos', { kind: 'semana', ref: '2026-09-24', bonus: { [I.barber('André')]: '10' } });
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.equal(f.data.start_date, '2026-09-21'); assert.equal(f.data.end_date, '2026-09-27');
  const c = (await api.get(`/api/fechamentos/${f.data.id}`)).data.snapshot;
  assert.equal(c.venda.bruto, 10000 + 95000);
  assert.equal(c.venda.taxas, 300 + 14250 + 2255);
  assert.equal(c.venda.liquido, 9700 + (95000 - 14250 - 2255));
  assert.equal(c.caixa.repasses_online, 7500 - 1000, 'repasse conta pela DATA DO REPASSE, não da venda');
  assert.equal(c.caixa.entradas, 9700 + 6500);
  assert.equal(c.caixa.saidas, 4290);
  assert.equal(c.online.a_receber >= 95000 - 14250 - 2255, true, 'venda sem repasse aparece como a receber');
  const fc = (await api.get(`/api/fechamentos/${f.data.id}`)).data;
  assert.equal(fc.bonus[I.barber('André')].valor, Math.round(5000 * 0.1));
  // correção DEPOIS do fechamento: o lançamento continua editável e o fechamento mostra a diferença
  await api.post('/api/saidas', { date: '2026-09-24', description: 'Lâminas', category: 'Suprimentos', amount: '20,00' });
  const depois = (await api.get(`/api/fechamentos/${f.data.id}`)).data;
  assert.ok(depois.diferencas.find((d) => d.campo === 'caixa.saidas' && d.atual === 6290 && d.no_fechamento === 4290));
  assert.ok(depois.alteracoes_depois.length >= 1);
  const mes = await api.post('/api/fechamentos', { kind: 'mes', ref: '2026-09-01' });
  assert.equal(mes.data.start_date, '2026-09-01'); assert.equal(mes.data.end_date, '2026-09-30');
});

test('10. texto em campo numérico é bloqueado e não afeta os totais', async () => {
  const antes = (await api.get('/api/relatorio?periodo=mes&ref=2026-09-01')).data;
  const casos = [
    ['/api/atendimentos', { date: '2026-09-25', barber_id: I.barber('Pedro'), payment_method: 'Pix', items: [{ service_id: I.service('Corte'), price: 'Haver' }] }],
    ['/api/atendimentos', { date: '2026-09-25', barber_id: I.barber('Pedro'), payment_method: 'Pix', items: [{ service_id: I.service('Corte') }], received: 'abc' }],
    ['/api/balcao', { date: '2026-09-25', payment_method: 'Pix', items: [{ sku: 'ARG-001', qty: 'dois' }] }],
    ['/api/balcao', { date: '2026-09-25', payment_method: 'Pix', items: [{ sku: 'ARG-001', qty: 1, price: 'Havere' }] }],
    ['/api/online', { channel: 'amazon', order_number: 'X-1', date: '2026-09-25', items: [{ sku: 'ARG-001', qty: 1 }], fees: 'dez reais' }],
    ['/api/saidas', { date: '2026-09-25', description: 'x', amount: '12,3,4' }],
    ['/api/contas', { description: 'x', amount: 'R$ cem', due_date: '2026-09-30' }],
  ];
  for (const [url, body] of casos) {
    const r = await api.post(url, body);
    assert.equal(r.status, 400, `${url} deveria recusar: ${JSON.stringify(body)}`);
    assert.match(r.data.erro, /precisa ser/);
  }
  // importação: a linha com texto no valor é recusada e as outras entram
  const csv = 'pedido;data;sku;quantidade;valor liquido;status\nBAD-1;25/09/2026;ARG-001;1;Haver;pago\nOK-1;25/09/2026;ARG-001;1;50,00;pago';
  const imp = (await api.post('/api/online/importar', { channel: 'tiktok_shop', filename: 'x.csv', csv })).data;
  assert.equal(imp.criados, 1);
  assert.equal(imp.erros.length, 1);
  assert.equal(imp.erros[0].pedido, 'BAD-1');
  const depois = (await api.get('/api/relatorio?periodo=mes&ref=2026-09-01')).data;
  assert.equal(depois.servicos.total, antes.servicos.total, 'totais de serviço intactos');
  assert.equal(depois.balcao.total, antes.balcao.total);
  assert.equal(depois.caixa.saidas, antes.caixa.saidas);
  assert.equal(depois.online.canais.find((c) => c.canal === 'tiktok_shop').vendas.n, antes.online.canais.find((c) => c.canal === 'tiktok_shop').vendas.n + 1);
  assert.equal(typeof depois.venda.bruto, 'number');
});

test('11a. só a conta do proprietário acessa (API e páginas)', async () => {
  const semLogin = [await T.anon.get('/api/inicio'), await T.anon.get('/api/produtos'), await T.anon.get('/api/exportar/backup.sqlite')];
  for (const r of semLogin) assert.equal(r.status, 401);
  const pagina = await T.anon.get('/');
  assert.equal(pagina.status, 302);
  assert.equal(pagina.headers.get('location'), '/login');
  assert.equal((await T.anon.get('/app.js')).status, 302, 'nem o código da tela sai sem login');
  const errada = await T.anon.post('/api/login', { email: 'dono@verdugo.test', senha: 'errada123456' });
  assert.equal(errada.status, 401);
  assert.equal((await T.anon.post('/api/barbeiros', { name: 'Invasor' })).status, 401, 'não existe cadastro público');
  // com sessão, mas sem o cabeçalho próprio do app (ataque de outro site): recusado
  const res = await fetch(`${T.base}/api/barbeiros`, { method: 'POST', headers: { cookie: (await loginCookie()), 'content-type': 'application/json' }, body: '{"name":"X"}' });
  assert.equal(res.status, 403);
});

async function loginCookie() {
  const r = await T.anon.post('/api/login', { email: 'dono@verdugo.test', senha: 'SenhaForte2026' });
  return r.headers.get('set-cookie').split(';')[0];
}

test('11b. bloqueio após várias senhas erradas', async () => {
  // usa um IP "diferente" não é possível aqui; então testa no mesmo servidor com um cliente sem sessão
  let ultimo;
  for (let i = 0; i < 6; i++) ultimo = await T.anon.post('/api/login', { email: 'dono@verdugo.test', senha: `errada-${i}-xyz` });
  assert.equal(ultimo.status, 429, 'depois de 5 erros em 15 min, o login fica bloqueado temporariamente');
  db.prepare('DELETE FROM login_attempts').run();
});

test('13. backup completo e CSV podem ser baixados e restaurados', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const res = await fetch(`${T.base}/api/exportar/backup.sqlite`, { headers: { cookie: await loginCookie() } });
  assert.equal(res.status, 200);
  const file = join(mkdtempSync(join(tmpdir(), 'rest-')), 'b.sqlite');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const b = new DatabaseSync(file);
  assert.equal(b.prepare('SELECT COUNT(*) n FROM appointments').get().n, db.prepare('SELECT COUNT(*) n FROM appointments').get().n);
  assert.equal(b.prepare('SELECT COUNT(*) n FROM products').get().n, 47);
  b.close();
  const csv = await api.get('/api/exportar/atendimentos.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Data;Barbeiro;Serviços/);
  assert.match(csv.data, /Corte \(55\.00\) \+ Barba \(45\.00\) \+ Sombrancelha \(30\.00\)/);
});
