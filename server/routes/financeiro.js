import { Router } from 'express';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { h, notFound, HttpError } from '../http.js';
import { tx, audit, nowIso, all, one } from '../db.js';
import { text, parseMoney, parseDate, parseId, parsePct, oneOf, todaySP, parsePeriod, weekRange, monthRange, ValidationError } from '../validate.js';
import { periodReport, alerts, cashPosition } from '../services/reports.js';

/** troca undefined por null */
const nn = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v]));

const RECEIPT_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

export default function financeiro(db, { uploadsDir, receiptsInDb = false }) {
  const r = Router();

  // ======================= Contas a pagar =======================
  const loadPayable = (id) => {
    const p = one(db, 'SELECT * FROM payables WHERE id=?', id);
    if (p) p.saida = one(db, 'SELECT * FROM cash_outs WHERE payable_id=?', id);
    return p;
  };

  r.get('/contas', h((req) => {
    const st = req.query.status ? oneOf(req.query.status, ['pendente', 'pago', 'cancelado'], 'status') : null;
    return all(db, `SELECT p.*, (SELECT id FROM cash_outs c WHERE c.payable_id=p.id AND c.status='ativo') AS saida_id
                    FROM payables p WHERE (? IS NULL OR p.status=?) ORDER BY p.needs_review DESC,
                    CASE p.status WHEN 'pendente' THEN 0 WHEN 'pago' THEN 1 ELSE 2 END, p.due_date`, st, st);
  }));

  const payableFields = (b, before = {}) => nn({
    description: b.description !== undefined ? text(b.description, 'descrição', { required: true, max: 200 }) : before.description,
    supplier: b.supplier !== undefined ? text(b.supplier, 'fornecedor', { max: 120 }) : before.supplier,
    category: b.category !== undefined ? text(b.category, 'categoria', { max: 60 }) : before.category,
    amount_cents: b.amount !== undefined ? parseMoney(b.amount, 'valor') : before.amount_cents,
    due_date: b.due_date !== undefined ? parseDate(b.due_date, 'vencimento') : before.due_date,
    note: b.note !== undefined ? text(b.note, 'observações', { max: 1000 }) : before.note,
  });

  r.post('/contas', h((req) => tx(db, () => {
    const f = payableFields(req.body);
    if (!f.amount_cents) throw new ValidationError('Informe o valor.', 'amount');
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO payables(description, supplier, category, amount_cents, due_date, status, note, created_at, updated_at)
        VALUES (?,?,?,?,?,'pendente',?,?,?)`).run(f.description, f.supplier, f.category, f.amount_cents, f.due_date, f.note, now, now).lastInsertRowid);
    const row = loadPayable(id);
    audit(db, 'criar', 'conta', id, undefined, row);
    return row;
  })));

  r.put('/contas/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = loadPayable(id);
    if (!before) throw notFound('Conta');
    const f = payableFields(req.body, before);
    db.prepare('UPDATE payables SET description=?, supplier=?, category=?, amount_cents=?, due_date=?, note=?, updated_at=? WHERE id=?')
      .run(f.description, f.supplier, f.category, f.amount_cents, f.due_date, f.note, nowIso(), id);
    // conta já paga: a saída vinculada acompanha a correção (continua sendo UMA saída só)
    if (before.saida) db.prepare('UPDATE cash_outs SET description=?, category=?, amount_cents=?, updated_at=? WHERE id=?')
      .run(f.description, f.category, f.amount_cents, nowIso(), before.saida.id);
    const after = loadPayable(id);
    audit(db, 'editar', 'conta', id, before, after);
    return after;
  })));

  /** Pagar conta: gera UMA saída de caixa vinculada. Pagar de novo é recusado (não conta duas vezes). */
  r.post('/contas/:id/pagar', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = loadPayable(id);
    if (!before) throw notFound('Conta');
    if (before.needs_review) throw new HttpError(409, 'Esta conta veio da planilha e parece exemplo — confirme-a antes de pagar.');
    if (before.status === 'pago') throw new HttpError(409, 'Esta conta já está paga — a saída já foi registrada uma vez.');
    if (before.status === 'cancelado') throw new HttpError(409, 'Conta cancelada.');
    const date = parseDate(req.body.paid_date ?? todaySP(), 'data do pagamento');
    const pay = text(req.body.payment_method, 'forma de pagamento', { max: 60 });
    const resp = text(req.body.responsible, 'responsável', { max: 60 });
    const now = nowIso();
    db.prepare("UPDATE payables SET status='pago', paid_date=?, payment_method=?, updated_at=? WHERE id=?").run(date, pay, now, id);
    const desc = `Conta paga: ${before.description}${before.supplier ? ` (${before.supplier})` : ''}`;
    if (before.saida) {
      db.prepare(`UPDATE cash_outs SET date=?, description=?, category=?, amount_cents=?, payment_method=?, responsible=?, status='ativo', updated_at=? WHERE id=?`)
        .run(date, desc, before.category, before.amount_cents, pay, resp, now, before.saida.id);
    } else {
      db.prepare(`INSERT INTO cash_outs(date, description, category, amount_cents, payment_method, responsible, note, payable_id, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,'ativo',?,?)`).run(date, desc, before.category, before.amount_cents, pay, resp, before.note, id, now, now);
    }
    const after = loadPayable(id);
    audit(db, 'pagar', 'conta', id, before, after);
    return after;
  })));

  r.post('/contas/:id/desfazer-pagamento', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = loadPayable(id);
    if (!before) throw notFound('Conta');
    if (before.status !== 'pago') throw new HttpError(409, 'A conta não está paga.');
    db.prepare("UPDATE payables SET status='pendente', paid_date=NULL, payment_method=NULL, updated_at=? WHERE id=?").run(nowIso(), id);
    db.prepare("UPDATE cash_outs SET status='cancelado', updated_at=? WHERE payable_id=?").run(nowIso(), id);
    const after = loadPayable(id);
    audit(db, 'desfazer_pagamento', 'conta', id, before, after);
    return after;
  })));

  r.post('/contas/:id/cancelar', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = loadPayable(id);
    if (!before) throw notFound('Conta');
    if (before.status === 'pago') throw new HttpError(409, 'Conta paga: desfaça o pagamento antes de cancelar.');
    db.prepare("UPDATE payables SET status='cancelado', updated_at=? WHERE id=?").run(nowIso(), id);
    const after = loadPayable(id);
    audit(db, 'cancelar', 'conta', id, before, after);
    return after;
  })));

  r.post('/contas/:id/confirmar', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = loadPayable(id);
    if (!before) throw notFound('Conta');
    db.prepare('UPDATE payables SET needs_review=0, updated_at=? WHERE id=?').run(nowIso(), id);
    db.prepare('UPDATE cash_outs SET needs_review=0, updated_at=? WHERE payable_id=?').run(nowIso(), id);
    const after = loadPayable(id);
    audit(db, 'confirmar', 'conta', id, before, after);
    return after;
  })));

  // ======================= Saídas de caixa =======================
  r.get('/saidas', h((req) => {
    const ini = req.query.inicio ? parseDate(req.query.inicio, 'data inicial') : '0000-01-01';
    const fim = req.query.fim ? parseDate(req.query.fim, 'data final') : '9999-12-31';
    return all(db, `SELECT * FROM cash_outs WHERE date BETWEEN ? AND ? ORDER BY needs_review DESC, date DESC, id DESC LIMIT 1000`, ini, fim);
  }));

  function saveReceipt(receipt) {
    if (!receipt) return null;
    const ext = RECEIPT_TYPES[receipt.type];
    if (!ext) throw new ValidationError('Comprovante deve ser imagem (JPG/PNG/WEBP) ou PDF.', 'receipt');
    const buf = Buffer.from(String(receipt.data || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length) throw new ValidationError('Comprovante vazio.', 'receipt');
    if (buf.length > 4 * 1024 * 1024) throw new ValidationError('Comprovante grande demais (máx. 4 MB).', 'receipt');
    const name = `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`;
    if (db.remoteStorage) db.storagePut(name, buf.toString('base64'), receipt.type); // Supabase Storage (bucket privado)
    else if (receiptsInDb) db.prepare('INSERT INTO receipts(name, content_type, data_base64, created_at) VALUES (?,?,?,?)').run(name, receipt.type, buf.toString('base64'), nowIso());
    else { mkdirSync(uploadsDir, { recursive: true }); writeFileSync(join(uploadsDir, name), buf); }
    return name;
  }

  const outFields = (b, before = {}) => nn({
    date: b.date !== undefined ? parseDate(b.date, 'data') : (before.date ?? todaySP()),
    description: b.description !== undefined ? text(b.description, 'descrição', { required: true, max: 200 }) : before.description,
    category: b.category !== undefined ? text(b.category, 'categoria', { max: 60 }) : before.category,
    amount_cents: b.amount !== undefined ? parseMoney(b.amount, 'valor') : before.amount_cents,
    payment_method: b.payment_method !== undefined ? text(b.payment_method, 'forma de pagamento', { max: 60 }) : before.payment_method,
    responsible: b.responsible !== undefined ? text(b.responsible, 'responsável', { max: 60 }) : before.responsible,
    note: b.note !== undefined ? text(b.note, 'observação', { max: 1000 }) : before.note,
  });

  r.post('/saidas', h((req) => tx(db, () => {
    const f = outFields(req.body);
    if (!f.description) throw new ValidationError('Informe a descrição.', 'description');
    if (!f.amount_cents) throw new ValidationError('Informe o valor.', 'amount');
    const receipt = saveReceipt(req.body.receipt);
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO cash_outs(date, description, category, amount_cents, payment_method, responsible, note, receipt_path, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,'ativo',?,?)`)
      .run(f.date, f.description, f.category, f.amount_cents, f.payment_method, f.responsible, f.note, receipt, now, now).lastInsertRowid);
    const row = one(db, 'SELECT * FROM cash_outs WHERE id=?', id);
    audit(db, 'criar', 'saida', id, undefined, row);
    return row;
  })));

  r.put('/saidas/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = one(db, 'SELECT * FROM cash_outs WHERE id=?', id);
    if (!before) throw notFound('Saída');
    if (before.payable_id && (req.body.amount !== undefined || req.body.date !== undefined))
      throw new HttpError(409, 'Esta saída veio de uma conta paga — corrija valor/data pela conta em "Contas a pagar".');
    const f = outFields(req.body, before);
    const receipt = req.body.receipt ? saveReceipt(req.body.receipt) : before.receipt_path;
    db.prepare(`UPDATE cash_outs SET date=?, description=?, category=?, amount_cents=?, payment_method=?, responsible=?, note=?, receipt_path=?, updated_at=? WHERE id=?`)
      .run(f.date, f.description, f.category, f.amount_cents, f.payment_method, f.responsible, f.note, receipt, nowIso(), id);
    const after = one(db, 'SELECT * FROM cash_outs WHERE id=?', id);
    audit(db, 'editar', 'saida', id, before, after);
    return after;
  })));

  for (const [path, patch] of [['cancelar', "status='cancelado'"], ['reativar', "status='ativo'"], ['confirmar', 'needs_review=0']]) {
    r.post(`/saidas/:id/${path}`, h((req) => tx(db, () => {
      const id = parseId(req.params.id);
      const before = one(db, 'SELECT * FROM cash_outs WHERE id=?', id);
      if (!before) throw notFound('Saída');
      if (before.payable_id) throw new HttpError(409, path === 'confirmar'
        ? 'Esta saída veio de uma conta — confirme pela conta, em "Contas a pagar".'
        : 'Saída de conta paga — use "desfazer pagamento" na conta.');
      db.prepare(`UPDATE cash_outs SET ${patch}, updated_at=? WHERE id=?`).run(nowIso(), id);
      const after = one(db, 'SELECT * FROM cash_outs WHERE id=?', id);
      audit(db, path, 'saida', id, before, after);
      return after;
    })));
  }

  r.get('/saidas/:id/comprovante', (req, res, next) => {
    try {
      const row = one(db, 'SELECT receipt_path FROM cash_outs WHERE id=?', parseId(req.params.id));
      if (!row?.receipt_path) throw notFound('Comprovante');
      const type = Object.entries(RECEIPT_TYPES).find(([, e]) => e === extname(row.receipt_path))?.[0] || 'application/octet-stream';
      let buf;
      if (db.remoteStorage) {
        const f = db.storageGet(row.receipt_path);
        if (!f.found) throw notFound('Comprovante');
        buf = Buffer.from(f.data, 'base64');
      } else if (receiptsInDb) {
        const f = one(db, 'SELECT data_base64 FROM receipts WHERE name=?', row.receipt_path);
        if (!f) throw notFound('Comprovante');
        buf = Buffer.from(f.data_base64, 'base64');
      } else {
        if (!existsSync(join(uploadsDir, row.receipt_path))) throw notFound('Comprovante');
        buf = readFileSync(join(uploadsDir, row.receipt_path));
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', type);
      res.send(buf);
    } catch (e) { next(e); }
  });

  // ======================= Caixa e bancos =======================
  r.get('/caixas', h(() => ({ contas: all(db, 'SELECT * FROM cash_accounts ORDER BY active DESC, name'), posicao: cashPosition(db) })));

  r.post('/caixas', h((req) => tx(db, () => {
    const now = nowIso();
    const id = Number(db.prepare('INSERT INTO cash_accounts(name, opening_cents, opening_date, active, needs_review, created_at, updated_at) VALUES (?,?,?,1,0,?,?)')
      .run(text(req.body.name, 'nome da conta', { required: true, max: 80 }), parseMoney(req.body.opening, 'saldo inicial', { allowNegative: true }),
        parseDate(req.body.opening_date ?? todaySP(), 'data do saldo'), now, now).lastInsertRowid);
    const row = one(db, 'SELECT * FROM cash_accounts WHERE id=?', id);
    audit(db, 'criar', 'caixa', id, undefined, row);
    return row;
  })));

  r.put('/caixas/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const b = one(db, 'SELECT * FROM cash_accounts WHERE id=?', id);
    if (!b) throw notFound('Conta de caixa');
    const name = req.body.name !== undefined ? text(req.body.name, 'nome da conta', { required: true, max: 80 }) : b.name;
    const op = req.body.opening !== undefined ? parseMoney(req.body.opening, 'saldo inicial', { allowNegative: true }) : b.opening_cents;
    const od = req.body.opening_date !== undefined ? parseDate(req.body.opening_date, 'data do saldo') : b.opening_date;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : b.active;
    const review = req.body.confirmar ? 0 : b.needs_review;
    db.prepare('UPDATE cash_accounts SET name=?, opening_cents=?, opening_date=?, active=?, needs_review=?, updated_at=? WHERE id=?')
      .run(name, op, od, active, review, nowIso(), id);
    const after = one(db, 'SELECT * FROM cash_accounts WHERE id=?', id);
    audit(db, 'editar', 'caixa', id, b, after);
    return after;
  })));

  // ======================= Relatórios, início e fechamentos =======================
  r.get('/relatorio', h((req) => {
    const p = parsePeriod(req.query, 'mes');
    return { ...periodReport(db, p.start, p.end), tipo: p.kind };
  }));

  r.get('/inicio', h((req) => {
    const p = parsePeriod(req.query, 'mes');
    const rep = periodReport(db, p.start, p.end);
    return {
      periodo: rep.periodo, tipo: p.kind,
      indicadores: {
        venda_bruta: rep.venda.bruto, entradas: rep.caixa.entradas, saidas: rep.caixa.saidas, resultado: rep.caixa.resultado,
        a_receber_online: rep.online.a_receber, comissoes: rep.servicos.comissao,
      },
      ranking: rep.servicos.por_barbeiro.filter((b) => b.atendimentos > 0).slice(0, 5),
      canais: rep.online.canais.map((c) => ({ canal: c.canal, nome: c.nome, bruto: c.vendas.bruto, pedidos: c.vendas.n })),
      alertas: alerts(db),
      caixa: cashPosition(db),
    };
  }));

  r.get('/fechamentos', h(() => all(db, 'SELECT id, kind, start_date, end_date, note, closed_at, bonus_json FROM closings ORDER BY start_date DESC, id DESC')));

  r.post('/fechamentos', h((req) => tx(db, () => {
    const kind = oneOf(req.body.kind, ['semana', 'mes'], 'tipo de fechamento');
    const ref = parseDate(req.body.ref ?? todaySP(), 'data de referência');
    const { start, end } = kind === 'semana' ? weekRange(ref) : monthRange(ref);
    const rep = periodReport(db, start, end);
    const bonus = {};
    for (const [bid, pctRaw] of Object.entries(req.body.bonus || {})) {
      const pct = parsePct(pctRaw, 'bônus');
      if (!pct) continue;
      const b = rep.servicos.por_barbeiro.find((x) => String(x.id) === String(bid));
      if (!b) throw new ValidationError('Bônus para barbeiro sem atendimentos no período.', 'bonus');
      bonus[bid] = { nome: b.name, pct, comissao: b.comissao, valor: Math.round(b.comissao * pct) };
    }
    const id = Number(db.prepare('INSERT INTO closings(kind, start_date, end_date, snapshot_json, bonus_json, note, closed_at) VALUES (?,?,?,?,?,?,?)')
      .run(kind, start, end, JSON.stringify(rep), JSON.stringify(bonus), text(req.body.note, 'observação', { max: 1000 }), nowIso()).lastInsertRowid);
    audit(db, 'fechar', 'fechamento', id, undefined, { kind, start, end, bonus });
    return { id, kind, start_date: start, end_date: end };
  })));

  /** Abre um fechamento: mostra a foto guardada e compara com os números atuais (correções feitas depois). */
  r.get('/fechamentos/:id', h((req) => {
    const c = one(db, 'SELECT * FROM closings WHERE id=?', parseId(req.params.id));
    if (!c) throw notFound('Fechamento');
    const snap = JSON.parse(c.snapshot_json);
    const cur = periodReport(db, c.start_date, c.end_date);
    const keys = [['venda', 'bruto'], ['venda', 'descontos'], ['venda', 'taxas'], ['venda', 'liquido'], ['caixa', 'entradas'], ['caixa', 'saidas'], ['caixa', 'resultado']];
    const diferencas = keys.filter(([a, b]) => snap[a][b] !== cur[a][b]).map(([a, b]) => ({ campo: `${a}.${b}`, no_fechamento: snap[a][b], atual: cur[a][b] }));
    const alteracoes = all(db, `SELECT * FROM audit_log WHERE at > ? AND entity IN ('atendimento','venda_balcao','pedido_online','saida','conta')
                                ORDER BY id DESC LIMIT 200`, c.closed_at)
      .filter((a) => {
        const touch = [a.before_json, a.after_json].filter(Boolean).map((j) => JSON.parse(j));
        return touch.some((o) => [o.date, o.paid_date, o.payout_date].some((d) => d && d >= c.start_date && d <= c.end_date));
      });
    return { ...c, snapshot: snap, bonus: JSON.parse(c.bonus_json || '{}'), atual: cur, diferencas, alteracoes_depois: alteracoes };
  }));

  return r;
}
