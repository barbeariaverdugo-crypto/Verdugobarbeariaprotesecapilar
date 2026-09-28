// Importa para o banco do app os dados extraídos da planilha (dados/planilha_extraida.json).
// Uso:  npm run importar-planilha            (usa dados/planilha_extraida.json e dados/verdugo.db)
//       node scripts/importar-planilha.js <arquivo.json> <banco.db>
// Pode rodar mais de uma vez: o que já existe (mesmo SKU/nome) não é duplicado.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx, nowIso, audit, setSetting } from '../server/db.js';
import { seedDefaults } from '../server/seed.js';
import { addMovement } from '../server/services/stock.js';
import { parseMoney, todaySP } from '../server/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function importPlanilha(db, data) {
  seedDefaults(db);
  const rep = { barbeiros: 0, servicos: 0, produtos: 0, contas: 0, caixas: 0, listas: 0, atendimentos: 0, saidas: 0, balcao: 0, online: 0, ignorados: [] };
  const now = nowIso();
  const today = todaySP();
  tx(db, () => {
    const insList = db.prepare('INSERT OR IGNORE INTO lists(kind, name, active, position) VALUES (?,?,1,?)');
    for (const [kind, names] of Object.entries(data.listas || {})) names.forEach((n, i) => { rep.listas += Number(insList.run(kind, n, 100 + i).changes); });
    // Responsáveis pelas saídas: começa com os nomes que aparecem na planilha (confirme/edite em Cadastros)
    (data.barbeiros || []).forEach((n, i) => insList.run('responsavel', n, i + 1));
    if (data.comissao_padrao !== undefined) setSetting(db, 'commission_pct_default', data.comissao_padrao);

    const insB = db.prepare('INSERT OR IGNORE INTO barbers(name, commission_pct, active, created_at, updated_at) VALUES (?, NULL, 1, ?, ?)');
    for (const n of data.barbeiros || []) rep.barbeiros += Number(insB.run(n, now, now).changes);

    const insS = db.prepare('INSERT OR IGNORE INTO services(name, price_cents, active, created_at, updated_at) VALUES (?,?,1,?,?)');
    for (const s of data.servicos || []) rep.servicos += Number(insS.run(s.nome, Math.round((s.preco || 0) * 100), now, now).changes);

    const insP = db.prepare(`INSERT OR IGNORE INTO products(sku, name, category, cost_cents, price_cents, min_stock, supplier, notes,
                             cost_pending, price_pending, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`);
    for (const p of data.produtos || []) {
      const r = insP.run(p.sku, p.nome, p.categoria, Math.round(p.custo * 100), Math.round(p.preco * 100), p.minimo || 0,
        p.fornecedor, p.obs, p.custo_a_confirmar ? 1 : 0, p.preco_a_confirmar ? 1 : 0, now, now);
      if (r.changes) {
        rep.produtos++;
        const id = Number(r.lastInsertRowid);
        if (p.saldo) addMovement(db, { product_id: id, date: today, kind: 'saldo_inicial', qty: p.saldo, unit_cost_cents: Math.round(p.custo * 100),
          source: 'planilha', note: 'Saldo importado da planilha (Estoque Inicial + Compras − vendido)' });
      }
    }

    const hasPayable = db.prepare('SELECT id FROM payables WHERE description=? AND due_date=? AND amount_cents=?');
    for (const c of data.contas || []) {
      const cents = Math.round(c.valor * 100);
      if (hasPayable.get(c.descricao, c.vencimento, cents)) continue;
      const status = c.status === 'pago' ? 'pago' : 'pendente';
      const id = Number(db.prepare(`INSERT INTO payables(description, category, amount_cents, due_date, status, paid_date, payment_method, note, needs_review, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(c.descricao, c.categoria, cents, c.vencimento, status, c.pago_em, c.forma,
        [c.obs, `Importado da planilha (linha ${c.linha}) — parece exemplo: confirme antes de usar.`].filter(Boolean).join(' | '),
        c.a_confirmar ? 1 : 0, now, now).lastInsertRowid);
      if (status === 'pago') db.prepare(`INSERT INTO cash_outs(date, description, category, amount_cents, payment_method, payable_id, status, needs_review, created_at, updated_at)
          VALUES (?,?,?,?,?,?,'ativo',?,?,?)`).run(c.pago_em || c.vencimento, `Conta paga: ${c.descricao}`, c.categoria, cents, c.forma, id, c.a_confirmar ? 1 : 0, now, now);
      rep.contas++;
    }

    const hasAcc = db.prepare('SELECT id FROM cash_accounts WHERE name=?');
    for (const a of data.caixas || []) {
      if (hasAcc.get(a.nome)) continue;
      db.prepare('INSERT INTO cash_accounts(name, opening_cents, opening_date, active, needs_review, created_at, updated_at) VALUES (?,?,?,1,?,?,?)')
        .run(a.nome, Math.round(a.saldo * 100), today, a.a_confirmar ? 1 : 0, now, now);
      rep.caixas++;
    }

    // Lançamentos antigos (se houver): entram como estavam, um serviço por atendimento, com validação numérica.
    const barberByName = (n) => db.prepare('SELECT * FROM barbers WHERE name=? COLLATE NOCASE').get(n);
    const svcByName = (n) => db.prepare('SELECT * FROM services WHERE name=? COLLATE NOCASE').get(n);
    for (const a of data.atendimentos || []) {
      try {
        const b = barberByName(a.barbeiro); const s = svcByName(a.servico);
        if (!b || !s || !a.data) throw new Error('barbeiro/serviço/data não encontrado');
        const cheio = Math.round((a.valor_cheio ?? s.price_cents / 100) * 100);
        const rec = a.recebido_bruto === null || a.recebido_bruto === undefined || a.recebido_bruto === '' ? cheio : parseMoney(a.recebido_bruto, 'valor recebido');
        const pct = b.commission_pct ?? Number(db.prepare("SELECT value FROM settings WHERE key='commission_pct_default'").get().value);
        const id = Number(db.prepare(`INSERT INTO appointments(date, barber_id, payment_method, subtotal_cents, discount_cents, total_cents, received_cents, card_fee_cents,
            commission_pct, commission_base_mode, commission_base_cents, commission_cents, note, status, created_at, updated_at) VALUES (?,?,?,?,0,?,?,?,?,'tabela',?,?,?,'ativo',?,?)`)
          .run(a.data, b.id, a.forma || 'Dinheiro', cheio, cheio, Math.min(rec, cheio), Math.max(0, cheio - rec), pct, cheio, Math.round(cheio * pct),
            `Importado da planilha (${a.aba}, linha ${a.linha})`, now, now).lastInsertRowid);
        db.prepare('INSERT INTO appointment_items(appointment_id, service_id, service_name, price_cents, is_main, position) VALUES (?,?,?,?,1,0)').run(id, s.id, s.name, cheio);
        rep.atendimentos++;
      } catch (e) { rep.ignorados.push(`${a.aba} linha ${a.linha}: ${e.message}`); }
    }
    for (const s of data.saidas || []) {
      try {
        const v = parseMoney(s.valor_bruto, 'valor');
        db.prepare(`INSERT INTO cash_outs(date, description, category, amount_cents, payment_method, note, status, needs_review, created_at, updated_at)
            VALUES (?,?,?,?,?,?,'ativo',0,?,?)`).run(s.data || today, s.descricao, s.categoria, v, s.forma, `Importado da planilha (${s.aba}, linha ${s.linha}) ${s.obs || ''}`.trim(), now, now);
        rep.saidas++;
      } catch (e) { rep.ignorados.push(`Saída ${s.aba} linha ${s.linha}: ${e.message}`); }
    }
    for (const v of data.vendas_balcao || []) {
      rep.ignorados.push(`Venda de balcão da planilha (linha ${v.linha}, ${v.produto_nome}) — registre no app: a planilha usa nome em vez de SKU.`);
    }
    for (const v of data.vendas_online || []) {
      rep.ignorados.push(`Venda ${v.canal} da planilha (linha ${v.linha}, ${v.sku}) — a planilha não tem número do pedido; importe pelo arquivo do marketplace.`);
    }
    audit(db, 'importar_planilha', 'sistema', null, undefined, rep);
  });
  return rep;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.argv[2] || join(root, 'dados', 'planilha_extraida.json');
  const dbFile = process.argv[3] || process.env.DB_FILE || join(root, 'dados', 'verdugo.db');
  const db = openDb(dbFile);
  const rep = importPlanilha(db, JSON.parse(readFileSync(src, 'utf8')));
  console.log(JSON.stringify(rep, null, 2));
}
