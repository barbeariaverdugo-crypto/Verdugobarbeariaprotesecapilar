import { Router } from 'express';
import { h, notFound, HttpError } from '../http.js';
import { tx, audit, nowIso, all, one, getSetting, setSetting } from '../db.js';
import { text, parseMoney, parsePct, parseId, parseInt0, oneOf, ValidationError } from '../validate.js';
import { verifyPassword, setOwner, validatePasswordStrength } from '../auth.js';

const LIST_KINDS = ['pagamento', 'cat_produto', 'cat_despesa', 'responsavel'];

export default function cadastros(db) {
  const r = Router();

  // ---------- Barbeiros ----------
  r.get('/barbeiros', h((req) => all(db, `SELECT b.*, (SELECT COUNT(*) FROM barber_notes n WHERE n.barber_id=b.id) AS anotacoes
                                          FROM barbers b ${req.query.todos ? '' : 'WHERE b.active=1'} ORDER BY b.active DESC, b.name`)));

  r.post('/barbeiros', h((req) => tx(db, () => {
    const name = text(req.body.name, 'nome do barbeiro', { required: true, max: 60 });
    const pct = parsePct(req.body.commission_pct, '% de comissão');
    const now = nowIso();
    const id = Number(db.prepare('INSERT INTO barbers(name, commission_pct, active, created_at, updated_at) VALUES (?,?,1,?,?)')
      .run(name, pct, now, now).lastInsertRowid);
    const row = one(db, 'SELECT * FROM barbers WHERE id=?', id);
    audit(db, 'criar', 'barbeiro', id, undefined, row);
    return row;
  })));

  r.put('/barbeiros/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = one(db, 'SELECT * FROM barbers WHERE id=?', id);
    if (!before) throw notFound('Barbeiro');
    const name = req.body.name !== undefined ? text(req.body.name, 'nome do barbeiro', { required: true, max: 60 }) : before.name;
    const pct = req.body.commission_pct !== undefined ? parsePct(req.body.commission_pct, '% de comissão') : before.commission_pct;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : before.active;
    db.prepare('UPDATE barbers SET name=?, commission_pct=?, active=?, updated_at=? WHERE id=?').run(name, pct, active, nowIso(), id);
    const after = one(db, 'SELECT * FROM barbers WHERE id=?', id);
    audit(db, 'editar', 'barbeiro', id, before, after);
    return after; // lançamentos antigos guardam o id; o nome novo aparece nos relatórios, os valores antigos não mudam
  })));

  // Anotações do barbeiro (só o proprietário acessa — toda a API exige a sessão dele)
  r.get('/barbeiros/:id/anotacoes', h((req) => {
    const id = parseId(req.params.id);
    if (!one(db, 'SELECT id FROM barbers WHERE id=?', id)) throw notFound('Barbeiro');
    return all(db, 'SELECT * FROM barber_notes WHERE barber_id=? ORDER BY created_at DESC, id DESC', id);
  }));

  r.post('/barbeiros/:id/anotacoes', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    if (!one(db, 'SELECT id FROM barbers WHERE id=?', id)) throw notFound('Barbeiro');
    const t = text(req.body.text, 'anotação', { required: true, max: 4000 });
    const now = nowIso();
    const nid = Number(db.prepare('INSERT INTO barber_notes(barber_id, text, created_at, updated_at) VALUES (?,?,?,?)').run(id, t, now, now).lastInsertRowid);
    const row = one(db, 'SELECT * FROM barber_notes WHERE id=?', nid);
    audit(db, 'criar', 'anotacao', nid, undefined, row);
    return row;
  })));

  r.put('/anotacoes/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = one(db, 'SELECT * FROM barber_notes WHERE id=?', id);
    if (!before) throw notFound('Anotação');
    const t = text(req.body.text, 'anotação', { required: true, max: 4000 });
    db.prepare('UPDATE barber_notes SET text=?, updated_at=? WHERE id=?').run(t, nowIso(), id);
    const after = one(db, 'SELECT * FROM barber_notes WHERE id=?', id);
    audit(db, 'editar', 'anotacao', id, before, after);
    return after;
  })));

  // ---------- Serviços ----------
  r.get('/servicos', h((req) => all(db, `SELECT * FROM services ${req.query.todos ? '' : 'WHERE active=1'} ORDER BY active DESC, name`)));

  r.post('/servicos', h((req) => tx(db, () => {
    const name = text(req.body.name, 'nome do serviço', { required: true, max: 80 });
    const price = parseMoney(req.body.price, 'preço do serviço');
    const now = nowIso();
    const id = Number(db.prepare('INSERT INTO services(name, price_cents, active, created_at, updated_at) VALUES (?,?,1,?,?)').run(name, price, now, now).lastInsertRowid);
    const row = one(db, 'SELECT * FROM services WHERE id=?', id);
    audit(db, 'criar', 'servico', id, undefined, row);
    return row;
  })));

  r.put('/servicos/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = one(db, 'SELECT * FROM services WHERE id=?', id);
    if (!before) throw notFound('Serviço');
    const name = req.body.name !== undefined ? text(req.body.name, 'nome do serviço', { required: true, max: 80 }) : before.name;
    const price = req.body.price !== undefined ? parseMoney(req.body.price, 'preço do serviço') : before.price_cents;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : before.active;
    db.prepare('UPDATE services SET name=?, price_cents=?, active=?, updated_at=? WHERE id=?').run(name, price, active, nowIso(), id);
    const after = one(db, 'SELECT * FROM services WHERE id=?', id);
    audit(db, 'editar', 'servico', id, before, after);
    return after; // atendimentos antigos guardam nome e preço praticados — não mudam
  })));

  // ---------- Listas (formas de pagamento, categorias, responsáveis) ----------
  r.get('/listas/:kind', h((req) => {
    const kind = oneOf(req.params.kind, LIST_KINDS, 'lista');
    return all(db, `SELECT * FROM lists WHERE kind=? ${req.query.todos ? '' : 'AND active=1'} ORDER BY active DESC, position, name`, kind);
  }));

  r.post('/listas/:kind', h((req) => tx(db, () => {
    const kind = oneOf(req.params.kind, LIST_KINDS, 'lista');
    const name = text(req.body.name, 'nome', { required: true, max: 60 });
    const pos = one(db, 'SELECT COALESCE(MAX(position),0)+1 p FROM lists WHERE kind=?', kind).p;
    const id = Number(db.prepare('INSERT INTO lists(kind, name, active, position) VALUES (?,?,1,?)').run(kind, name, pos).lastInsertRowid);
    const row = one(db, 'SELECT * FROM lists WHERE id=?', id);
    audit(db, 'criar', 'lista', id, undefined, row);
    return row;
  })));

  r.put('/listas/item/:id', h((req) => tx(db, () => {
    const id = parseId(req.params.id);
    const before = one(db, 'SELECT * FROM lists WHERE id=?', id);
    if (!before) throw notFound('Item');
    const name = req.body.name !== undefined ? text(req.body.name, 'nome', { required: true, max: 60 }) : before.name;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : before.active;
    db.prepare('UPDATE lists SET name=?, active=? WHERE id=?').run(name, active, id);
    const after = one(db, 'SELECT * FROM lists WHERE id=?', id);
    audit(db, 'editar', 'lista', id, before, after);
    return after;
  })));

  // ---------- Configurações ----------
  r.get('/configuracoes', h(() => ({
    commission_pct_default: Number(getSetting(db, 'commission_pct_default')),
    commission_base: getSetting(db, 'commission_base'),
    return_restock_default: getSetting(db, 'return_restock_default') === '1',
  })));

  r.put('/configuracoes', h((req) => tx(db, () => {
    const before = { pct: getSetting(db, 'commission_pct_default'), base: getSetting(db, 'commission_base'), dev: getSetting(db, 'return_restock_default') };
    if (req.body.commission_pct_default !== undefined) {
      const p = parsePct(req.body.commission_pct_default, '% de comissão padrão');
      if (p === null) throw new ValidationError('Informe a % de comissão padrão.', 'commission_pct_default');
      setSetting(db, 'commission_pct_default', p);
    }
    if (req.body.commission_base !== undefined) setSetting(db, 'commission_base', oneOf(req.body.commission_base, ['tabela', 'apos_desconto'], 'base da comissão'));
    if (req.body.return_restock_default !== undefined) setSetting(db, 'return_restock_default', req.body.return_restock_default ? '1' : '0');
    audit(db, 'editar', 'configuracao', null, before, req.body);
    return { ok: true };
  })));

  // ---------- Auditoria ----------
  r.get('/auditoria', h((req) => {
    const lim = req.query.limite === undefined ? 100 : parseInt0(req.query.limite, 'limite', { min: 1, max: 500 });
    const ent = typeof req.query.entidade === 'string' ? req.query.entidade : null;
    const eid = ent && req.query.id !== undefined ? parseId(req.query.id, 'id') : null;
    const where = ent ? 'WHERE entity = ? AND (? IS NULL OR entity_id = ?)' : '';
    const params = ent ? [ent, eid, eid] : [];
    return all(db, `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`, ...params, lim);
  }));

  // ---------- Senha ----------
  r.post('/senha', h((req) => {
    const owner = one(db, 'SELECT * FROM owner WHERE id=1');
    if (!verifyPassword(String(req.body.atual || ''), owner.pass_hash)) throw new HttpError(400, 'A senha atual não confere.');
    const err = validatePasswordStrength(req.body.nova);
    if (err) throw new HttpError(400, err);
    setOwner(db, owner.email, req.body.nova);
    audit(db, 'editar', 'senha', 1);
    return { ok: true, mensagem: 'Senha alterada. Entre novamente.' };
  }));

  return r;
}
