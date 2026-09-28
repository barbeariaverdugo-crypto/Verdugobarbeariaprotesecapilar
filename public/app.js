'use strict';
/* Verdugo — aplicativo (tela única). Toda a lógica de dinheiro/estoque fica no servidor;
   aqui só mostramos, validamos cedo e enviamos. */

// ============================== utilidades ==============================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const brDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '');
const moneyIn = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const CANAIS = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', amazon: 'Amazon' };
const STATUS_ON = { pago: 'Pago', enviado: 'Enviado', entregue: 'Entregue', cancelado: 'Cancelado', devolvido: 'Devolvido' };

/** Mesmo critério do servidor: "1.234,56", "1234,56", "1234.56". Devolve centavos ou NaN. */
function parseBRL(v) {
  const s = String(v ?? '').replace(/R\$/gi, '').replace(/\s/g, '');
  if (s === '') return 0;
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(s)) return Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100);
  if (/^\d+(\.\d{1,2})?$/.test(s)) return Math.round(Number(s) * 100);
  return NaN;
}

class ApiError extends Error { constructor(m, campo) { super(m); this.campo = campo; } }
async function api(method, path, body) {
  const opt = { method, headers: { 'x-verdugo': '1' } };
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch('/api' + path, opt); } catch { throw new ApiError('Sem conexão com o servidor. Nada foi salvo.'); }
  if (r.status === 401) { location.href = '/login'; throw new ApiError('Sessão expirada.'); }
  const d = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(d.erro || 'Erro inesperado.', d.campo);
  return d;
}
const GET = (p) => api('GET', p);
const POST = (p, b = {}) => api('POST', p, b);
const PUT = (p, b = {}) => api('PUT', p, b);

let toastTimer;
function toast(msg, erro = false) {
  $('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast' + (erro ? ' erro' : '');
  t.setAttribute('role', erro ? 'alert' : 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), erro ? 6000 : 3000);
}

/** Folha/modal com conteúdo HTML. */
function sheet(title, html) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-fechar>Fechar</button></div>
      <div class="sheet-body">${html}</div></div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-fechar]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  const first = bg.querySelector('input, select, textarea');
  if (first && window.innerWidth > 700) first.focus();
  return { el: bg.querySelector('.sheet-body'), close };
}

const opts = (list, { value = 'id', label = 'name', selected = null, empty = null } = {}) =>
  (empty !== null ? `<option value="">${esc(empty)}</option>` : '') +
  list.map((x) => `<option value="${esc(x[value])}" ${String(x[value]) === String(selected ?? '') ? 'selected' : ''}>${esc(typeof label === 'function' ? label(x) : x[label])}</option>`).join('');

/** Liga validação imediata nos campos de dinheiro: texto inválido fica vermelho e bloqueia o envio. */
function moneyGuard(root) {
  $$('input[data-money]', root).forEach((inp) => {
    inp.setAttribute('inputmode', 'decimal');
    inp.setAttribute('autocomplete', 'off');
    const check = () => inp.classList.toggle('invalido', Number.isNaN(parseBRL(inp.value)));
    inp.addEventListener('input', check);
    check();
  });
  $$('input[data-int]', root).forEach((inp) => {
    inp.setAttribute('inputmode', 'numeric');
    const check = () => inp.classList.toggle('invalido', inp.value !== '' && !/^-?\d+$/.test(inp.value.trim()));
    inp.addEventListener('input', check);
    check();
  });
}
function hasInvalid(root) {
  const bad = $$('.invalido', root);
  if (bad.length) { bad[0].focus(); toast('Há um valor inválido (em vermelho). Use só números, ex.: 45,00.', true); return true; }
  return false;
}
async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); return undefined; } finally { if (btn) btn.disabled = false; }
}

// ============================== dados de apoio ==============================
const ref = {};
async function loadRefs(force = false) {
  if (ref.ok && !force) return ref;
  const [barbeiros, barbeirosTodos, servicos, pagamentos, catProduto, catDespesa, responsaveis, config] = await Promise.all([
    GET('/barbeiros'), GET('/barbeiros?todos=1'), GET('/servicos'), GET('/listas/pagamento'), GET('/listas/cat_produto'),
    GET('/listas/cat_despesa'), GET('/listas/responsavel'), GET('/configuracoes')]);
  Object.assign(ref, { ok: true, barbeiros, barbeirosTodos, servicos, pagamentos, catProduto, catDespesa, responsaveis, config });
  return ref;
}
async function loadProdutos() { ref.produtos = await GET('/produtos'); return ref.produtos; }

// ============================== período ==============================
const periodoState = { periodo: 'mes', ref: null, inicio: null, fim: null };
function periodoQS(p = periodoState) {
  if (p.periodo === 'personalizado') return `periodo=personalizado&inicio=${p.inicio}&fim=${p.fim}`;
  return `periodo=${p.periodo}${p.ref ? `&ref=${p.ref}` : ''}`;
}
function periodoBar(onChange, { hoje = false } = {}) {
  const p = periodoState;
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  const items = [...(hoje ? [['hoje', 'Hoje']] : []), ['semana', 'Semana'], ['mes', 'Mês'], ['personalizado', 'Período']];
  wrap.innerHTML = `<div class="chips">${items.map(([k, l]) => `<button class="chip ${p.periodo === k ? 'ativo' : ''}" data-p="${k}">${l}</button>`).join('')}
      <input type="date" class="chip" data-ref value="${esc(p.ref || today())}" title="Semana/mês de referência" ${p.periodo === 'personalizado' || p.periodo === 'hoje' ? 'hidden' : ''}></div>
    <div class="form linha c2 ${p.periodo === 'personalizado' ? '' : 'hidden'}" data-custom>
      <label>De<input type="date" data-ini value="${esc(p.inicio || today().slice(0, 8) + '01')}"></label>
      <label>Até<input type="date" data-fim value="${esc(p.fim || today())}"></label></div>`;
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    p.periodo = b.dataset.p;
    if (p.periodo === 'personalizado') { p.inicio = $('[data-ini]', wrap).value; p.fim = $('[data-fim]', wrap).value; }
    onChange();
  });
  wrap.addEventListener('change', (e) => {
    if (e.target.matches('[data-ref]')) { p.ref = e.target.value || null; onChange(); }
    if (e.target.matches('[data-ini],[data-fim]')) { p.inicio = $('[data-ini]', wrap).value; p.fim = $('[data-fim]', wrap).value; if (p.inicio && p.fim) onChange(); }
  });
  return wrap;
}
const periodoLabel = (per) => (per.inicio === per.fim ? brDate(per.inicio) : `${brDate(per.inicio)} a ${brDate(per.fim)}`);

// ============================== navegação ==============================
const ICON = {
  inicio: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8v10H3z"/><path d="M9 21v-6h6v6"/></svg>',
  atendimentos: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1L20 20M8.1 15.9L20 4"/></svg>',
  vendas: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16l-1.5 12h-13z"/><path d="M9 7a3 3 0 016 0"/></svg>',
  estoque: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
  financeiro: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  cadastros: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
};
const NAV = [['inicio', 'Início'], ['atendimentos', 'Atendimentos'], ['vendas', 'Vendas'], ['estoque', 'Estoque'], ['financeiro', 'Financeiro']];
function renderNav(active) {
  const link = ([k, l]) => `<a href="#/${k}" class="${active === k ? 'ativo' : ''}"><span class="ic">${ICON[k]}</span><span>${l}</span></a>`;
  $('#bottomnav').innerHTML = NAV.map(link).join('');
  $('#sidebar').innerHTML = NAV.map(link).join('') + '<div class="sep"></div>' + link(['cadastros', 'Cadastros']);
}

const PAGES = {};
async function router() {
  const [route = 'inicio', sub = ''] = location.hash.replace(/^#\/?/, '').split('/');
  const page = PAGES[route] ? route : 'inicio';
  renderNav(page);
  const main = $('#main');
  main.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    await loadRefs();
    await PAGES[page](main, sub);
  } catch (e) {
    main.innerHTML = `<div class="alert red">${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}
function setTitle(t) { $('#titulo').textContent = t; document.title = `${t} — Verdugo`; }

// ============================== INÍCIO ==============================
PAGES.inicio = async (main) => {
  setTitle('Início');
  main.innerHTML = `<div class="page-head"><h1>Resumo</h1><span class="faint" data-per></span></div><div data-pb></div><div data-body class="stack"></div>`;
  const load = async () => {
    const d = await GET('/inicio?' + periodoQS());
    $('[data-per]', main).textContent = periodoLabel(d.periodo);
    const k = d.indicadores; const a = d.alertas;
    const rev = a.revisar;
    const revItens = [
      rev.contas && `<a href="#/financeiro/contas">${rev.contas} conta(s) importada(s) da planilha a confirmar</a>`,
      rev.caixas && `<a href="#/financeiro/caixa">${rev.caixas} saldo(s) de banco/caixa a confirmar</a>`,
      rev.precos && `<a href="#/estoque/confirmar">${rev.precos} produto(s) com preço ou custo não confirmado</a>`,
      rev.sku_desconhecido && `<a href="#/vendas/online">${rev.sku_desconhecido} item(ns) online com SKU não cadastrado</a>`,
    ].filter(Boolean);
    $('[data-body]', main).innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="rot">Venda bruta</div><div class="val">${brl(k.venda_bruta)}</div><div class="sub">serviços, balcão e online</div></div>
        <div class="kpi"><div class="rot">Entrou no caixa</div><div class="val">${brl(k.entradas)}</div><div class="sub">online pela data do repasse</div></div>
        <div class="kpi"><div class="rot">Saídas</div><div class="val">${brl(k.saidas)}</div><div class="sub">gastos e contas pagas</div></div>
        <div class="kpi ${k.resultado >= 0 ? 'pos' : 'neg'}"><div class="rot">Resultado do caixa</div><div class="val">${brl(k.resultado)}</div><div class="sub">a receber online: ${brl(k.a_receber_online)}</div></div>
      </div>
      ${d.caixa ? `<div class="card"><div class="page-head"><h3>Caixa e bancos (estimado)</h3><a href="#/financeiro/caixa" class="faint">detalhes</a></div>
          <div class="kpi-inline"><strong class="num">${brl(d.caixa.saldo_estimado)}</strong> <span class="faint">saldo inicial ${brl(d.caixa.saldo_inicial)} desde ${brDate(d.caixa.desde)}</span></div></div>` : ''}
      <div class="grid grid-2">
        <div class="card stack"><h3>Alertas</h3>
          ${a.contas_vencidas.length ? `<div class="alert red"><strong>${a.contas_vencidas.length} conta(s) vencida(s)</strong> — ${a.contas_vencidas.slice(0, 3).map((c) => `${esc(c.description)} (${brDate(c.due_date)}, ${brl(c.amount_cents)})`).join('; ')} <a href="#/financeiro/contas">ver</a></div>` : ''}
          ${a.contas_a_vencer.length ? `<div class="alert amber"><strong>${a.contas_a_vencer.length} conta(s) vencendo em 7 dias</strong> — ${a.contas_a_vencer.slice(0, 3).map((c) => `${esc(c.description)} (${brDate(c.due_date)})`).join('; ')}</div>` : ''}
          ${a.estoque_baixo.length ? `<div class="alert amber"><strong>${a.estoque_baixo.length} produto(s) com estoque baixo</strong> — ${a.estoque_baixo.slice(0, 5).map((p) => `${esc(p.sku)} (${p.saldo})`).join(', ')} <a href="#/estoque/baixo">ver</a></div>` : ''}
          ${revItens.length ? `<div class="alert blue"><strong>Para conferir:</strong><br>${revItens.join('<br>')}</div>` : ''}
          ${!a.contas_vencidas.length && !a.contas_a_vencer.length && !a.estoque_baixo.length && !revItens.length ? '<p class="empty">Nenhum alerta.</p>' : ''}
        </div>
        <div class="card"><div class="page-head"><h3>Barbeiros no período</h3><span class="faint">comissões ${brl(k.comissoes)}</span></div>
          <div class="list">${d.ranking.length ? d.ranking.map((b, i) => `<div class="row"><span class="badge ${i === 0 ? 'red' : ''}">${i + 1}º</span>
            <div class="main"><div class="t">${esc(b.name)}</div><div class="s">${b.atendimentos} atendimento(s)</div></div><div class="v">${brl(b.total)}</div></div>`).join('') : '<p class="empty">Sem atendimentos no período.</p>'}</div>
        </div>
      </div>
      <div class="card"><div class="page-head"><h3>Vendas online por canal</h3><a href="#/financeiro/relatorio">detalhes por canal</a></div>
        <div class="list">${d.canais.map((c) => `<div class="row"><div class="main"><div class="t">${esc(c.nome)}</div><div class="s">${c.pedidos} pedido(s)</div></div><div class="v">${brl(c.bruto)}</div></div>`).join('')}</div>
      </div>`;
  };
  $('[data-pb]', main).appendChild(periodoBar(load));
  await load();
};

// ============================== ATENDIMENTOS ==============================
function commissionPreview(barberId, subtotal, total) {
  const b = ref.barbeirosTodos.find((x) => String(x.id) === String(barberId));
  const pct = b?.commission_pct ?? ref.config.commission_pct_default;
  const base = ref.config.commission_base === 'apos_desconto' ? total : subtotal;
  return { pct, valor: Math.round(base * pct) };
}

async function notasPanel(container, barberId) {
  if (!barberId) { container.innerHTML = ''; container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  const b = ref.barbeirosTodos.find((x) => String(x.id) === String(barberId));
  container.innerHTML = '<p class="faint">Carregando anotações…</p>';
  const notas = await GET(`/barbeiros/${barberId}/anotacoes`);
  container.innerHTML = `<div class="page-head"><h3>Anotações — ${esc(b?.name)}</h3><span class="faint">só você vê</span></div>
    <div class="form"><textarea data-nova-nota placeholder="Nova anotação sobre ${esc(b?.name)}…"></textarea>
    <div class="acoes"><button type="button" class="btn pequeno azul" data-salvar-nota>Salvar anotação</button></div></div>
    <div data-lista-notas>${notas.length ? notas.slice(0, 20).map((n) => `<div class="nota"><div class="d">${brDateTime(n.created_at)}</div>${esc(n.text)}</div>`).join('') : '<p class="faint">Nenhuma anotação ainda.</p>'}</div>`;
  $('[data-salvar-nota]', container).addEventListener('click', (e) => run(e.target, async () => {
    const t = $('[data-nova-nota]', container).value.trim();
    if (!t) return toast('Escreva a anotação.', true);
    await POST(`/barbeiros/${barberId}/anotacoes`, { text: t });
    toast('Anotação salva.');
    await notasPanel(container, barberId);
  }));
}

function atendimentoForm(a = null, onSaved) {
  const svcList = (cur) => {
    const list = [...ref.servicos];
    if (cur && !list.find((s) => s.id === cur)) { const old = a?.items.find((i) => i.service_id === cur); if (old) list.push({ id: cur, name: `${old.service_name} (inativo)`, price_cents: old.price_cents }); }
    return list;
  };
  const itemRow = (it = {}, main = false) => `<div class="item" data-item data-id="${esc(it.id || '')}">
      <label>${main ? '<span class="tag">Serviço principal</span>' : 'Serviço adicional'}<select data-svc required>${opts(svcList(it.service_id), { selected: it.service_id, empty: 'Selecione…', label: (s) => `${s.name} — ${brl(s.price_cents)}` })}</select></label>
      <label>Preço<input data-money data-preco value="${esc(it.price_cents !== undefined ? moneyIn(it.price_cents) : '')}" placeholder="0,00"></label>
      ${main ? '<span></span>' : '<button type="button" class="btn fantasma rm" data-rm title="Remover">×</button>'}</div>`;
  const s = sheet(a ? `Atendimento #${a.id}` : 'Novo atendimento', `
    <form class="form" data-f>
      ${a?.status === 'cancelado' ? '<div class="alert red">Atendimento cancelado — não entra nos totais.</div>' : ''}
      <div class="linha c2">
        <label>Data<input type="date" name="date" value="${esc(a?.date || today())}" required></label>
        <label>Barbeiro<select name="barber_id" required>${opts(a ? ref.barbeirosTodos.filter((b) => b.active || b.id === a.barber_id) : ref.barbeiros, { selected: a?.barber_id, empty: 'Selecione…' })}</select></label>
      </div>
      <div class="card notas hidden" data-notas></div>
      <div class="itens" data-itens>${a ? a.items.map((it, i) => itemRow(it, i === 0)).join('') : itemRow({}, true)}</div>
      <button type="button" class="btn fantasma" data-add>+ Adicionar serviço extra</button>
      <div class="linha c3">
        <label>Desconto<input data-money name="discount" value="${esc(a ? moneyIn(a.discount_cents) : '')}" placeholder="0,00"></label>
        <label>Forma de pagamento<select name="payment_method" required>${opts(ref.pagamentos, { value: 'name', selected: a?.payment_method, empty: 'Selecione…' })}</select></label>
        <label>Valor recebido<input data-money name="received" value="${esc(a ? moneyIn(a.received_cents) : '')}" placeholder="= total"><span class="hint">o que entrou (após taxa da maquininha)</span></label>
      </div>
      <label>Observação<textarea name="note">${esc(a?.note || '')}</textarea></label>
      <div class="resumo" data-resumo></div>
      <div class="acoes">
        ${a ? `<button type="button" class="btn fantasma" data-status>${a.status === 'ativo' ? 'Cancelar atendimento' : 'Reativar'}</button>` : ''}
        <button class="btn primario" type="submit">${a ? 'Salvar alterações' : 'Registrar atendimento'}</button>
      </div>
    </form>`);
  const f = $('[data-f]', s.el);
  const resumo = () => {
    const precos = $$('[data-item]', f).map((row) => {
      const v = $('[data-preco]', row).value;
      if (v.trim() !== '') return parseBRL(v);
      const svc = ref.servicos.find((x) => String(x.id) === $('[data-svc]', row).value) || a?.items.find((i) => String(i.service_id) === $('[data-svc]', row).value);
      return svc ? (svc.price_cents ?? 0) : 0;
    });
    const sub = precos.reduce((t, p) => t + (Number.isNaN(p) ? 0 : p), 0);
    const desc = parseBRL(f.discount.value) || 0;
    const total = sub - desc;
    const rec = f.received.value.trim() === '' ? total : parseBRL(f.received.value);
    const com = commissionPreview(f.barber_id.value, sub, total);
    $('[data-resumo]', f).innerHTML = `<span>Serviços</span><span class="right">${brl(sub)}</span>
      <span>Desconto</span><span class="right">− ${brl(desc)}</span>
      <span class="tot">Total</span><span class="right tot">${brl(total)}</span>
      <span class="muted">Taxa maquininha</span><span class="right muted">${Number.isNaN(rec) ? '—' : brl(total - rec)}</span>
      <span class="muted">Comissão (${Math.round(com.pct * 100)}%)</span><span class="right muted">${f.barber_id.value ? brl(com.valor) : '—'}</span>`;
  };
  const onSvc = (row) => {
    const svc = ref.servicos.find((x) => String(x.id) === $('[data-svc]', row).value);
    if (svc) $('[data-preco]', row).value = moneyIn(svc.price_cents);
    moneyGuard(row); resumo();
  };
  f.addEventListener('change', (e) => {
    if (e.target.matches('[data-svc]')) onSvc(e.target.closest('[data-item]'));
    if (e.target.name === 'barber_id') { notasPanel($('[data-notas]', f), f.barber_id.value); resumo(); }
  });
  f.addEventListener('input', resumo);
  f.addEventListener('click', (e) => {
    if (e.target.matches('[data-add]')) {
      $('[data-itens]', f).insertAdjacentHTML('beforeend', itemRow());
      moneyGuard(f); $('[data-itens] [data-item]:last-child [data-svc]', f).focus();
    }
    if (e.target.matches('[data-rm]')) { e.target.closest('[data-item]').remove(); resumo(); }
  });
  $('[data-status]', f)?.addEventListener('click', (e) => run(e.target, async () => {
    if (a.status === 'ativo' && !confirm('Cancelar este atendimento? Ele continua no histórico, mas sai dos totais.')) return;
    await POST(`/atendimentos/${a.id}/${a.status === 'ativo' ? 'cancelar' : 'reativar'}`);
    toast('Atendimento atualizado.'); s.close(); onSaved();
  }));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (hasInvalid(f)) return;
    const items = $$('[data-item]', f).map((row, i) => ({ id: row.dataset.id ? Number(row.dataset.id) : undefined,
      service_id: $('[data-svc]', row).value, price: $('[data-preco]', row).value, is_main: i === 0 }));
    const body = { date: f.date.value, barber_id: f.barber_id.value, payment_method: f.payment_method.value, items,
      discount: f.discount.value, received: f.received.value, note: f.note.value };
    run($('button[type=submit]', f), async () => {
      await (a ? PUT(`/atendimentos/${a.id}`, body) : POST('/atendimentos', body));
      toast(a ? 'Atendimento atualizado.' : 'Atendimento registrado.'); s.close(); onSaved();
    });
  });
  moneyGuard(f); resumo();
  if (a) notasPanel($('[data-notas]', f), a.barber_id);
}

PAGES.atendimentos = async (main) => {
  setTitle('Atendimentos');
  const filtro = { barbeiro: '' };
  main.innerHTML = `<div class="page-head"><h1>Atendimentos</h1><button class="btn primario" data-novo>+ Novo atendimento</button></div>
    <div data-pb></div>
    <div class="card"><div class="page-head"><select data-fb class="chip">${opts(ref.barbeirosTodos, { empty: 'Todos os barbeiros' })}</select><span class="faint" data-tot></span></div>
      <div class="list" data-list></div></div>`;
  const load = async () => {
    const per = await GET('/relatorio?' + periodoQS());
    const rows = await GET(`/atendimentos?inicio=${per.periodo.inicio}&fim=${per.periodo.fim}${filtro.barbeiro ? `&barbeiro=${filtro.barbeiro}` : ''}`);
    const ativos = rows.filter((r) => r.status === 'ativo');
    $('[data-tot]', main).textContent = `${periodoLabel(per.periodo)} · ${ativos.length} atendimento(s) · ${brl(ativos.reduce((t, r) => t + r.total_cents, 0))}`;
    $('[data-list]', main).innerHTML = rows.length ? rows.map((r) => `<div class="row click ${r.status}" data-id="${r.id}">
        <div class="main"><div class="t">${esc(r.items.map((i) => i.service_name).join(' + '))}</div>
        <div class="s">${brDate(r.date)} · ${esc(r.barber_name)} · ${esc(r.payment_method)}${r.status === 'cancelado' ? ' · <span class="badge red">cancelado</span>' : ''}</div></div>
        <div class="v">${brl(r.total_cents)}</div></div>`).join('') : '<p class="empty">Nenhum atendimento no período.</p>';
  };
  $('[data-pb]', main).appendChild(periodoBar(load, { hoje: true }));
  $('[data-novo]', main).addEventListener('click', () => atendimentoForm(null, load));
  $('[data-fb]', main).addEventListener('change', (e) => { filtro.barbeiro = e.target.value; load(); });
  $('[data-list]', main).addEventListener('click', async (e) => {
    const row = e.target.closest('[data-id]');
    if (row) atendimentoForm(await GET(`/atendimentos/${row.dataset.id}`), load);
  });
  await load();
};

// ============================== VENDAS ==============================
const prodLabel = (p) => `${p.sku} — ${p.name} (saldo ${p.saldo ?? '?'})${p.price_pending ? ' · preço a confirmar' : ''}`;

function balcaoForm(v = null, onSaved) {
  const prods = ref.produtos;
  const itemRow = (it = {}) => `<div class="item prod" data-item data-id="${esc(it.id || '')}">
      <label>Produto (SKU)<select data-prod required>${opts(prods.filter((p) => p.active || p.id === it.product_id), { selected: it.product_id, empty: 'Selecione…', label: prodLabel })}${it.product_id && !prods.find((p) => p.id === it.product_id) ? `<option value="${esc(it.product_id)}" selected>${esc(it.sku)} — ${esc(it.product_name)} (inativo)</option>` : ''}</select></label>
      <label>Qtd<input data-int data-qtd value="${esc(it.qty ?? 1)}"></label>
      <label>Preço unit.<input data-money data-preco value="${esc(it.unit_price_cents !== undefined ? moneyIn(it.unit_price_cents) : '')}" placeholder="0,00"></label>
      <button type="button" class="btn fantasma rm" data-rm title="Remover">×</button></div>`;
  const s = sheet(v ? `Venda de balcão #${v.id}` : 'Nova venda de balcão', `
    <form class="form" data-f>
      ${v?.status === 'cancelado' ? '<div class="alert red">Venda cancelada — produtos voltaram ao estoque.</div>' : ''}
      <div class="linha c2">
        <label>Data<input type="date" name="date" value="${esc(v?.date || today())}" required></label>
        <label>Responsável pela venda (opcional)<select name="seller_barber_id">${opts(ref.barbeirosTodos.filter((b) => b.active || b.id === v?.seller_barber_id), { selected: v?.seller_barber_id, empty: '— ninguém —' })}</select></label>
      </div>
      <div class="itens" data-itens>${v ? v.items.map(itemRow).join('') : itemRow()}</div>
      <button type="button" class="btn fantasma" data-add>+ Adicionar produto</button>
      <div class="linha c3">
        <label>Desconto<input data-money name="discount" value="${esc(v ? moneyIn(v.discount_cents) : '')}" placeholder="0,00"></label>
        <label>Forma de pagamento<select name="payment_method" required>${opts(ref.pagamentos, { value: 'name', selected: v?.payment_method, empty: 'Selecione…' })}</select></label>
        <label>Valor recebido<input data-money name="received" value="${esc(v ? moneyIn(v.received_cents) : '')}" placeholder="= total"></label>
      </div>
      <label>Observação<textarea name="note">${esc(v?.note || '')}</textarea></label>
      <div class="resumo" data-resumo></div>
      <div class="acoes">
        ${v ? `<button type="button" class="btn fantasma" data-status>${v.status === 'ativo' ? 'Cancelar venda' : 'Reativar'}</button>` : ''}
        <button class="btn primario" type="submit">${v ? 'Salvar alterações' : 'Registrar venda'}</button></div>
    </form>`);
  const f = $('[data-f]', s.el);
  const resumo = () => {
    const sub = $$('[data-item]', f).reduce((t, row) => {
      const q = Number($('[data-qtd]', row).value) || 0; const p = parseBRL($('[data-preco]', row).value);
      return t + (Number.isNaN(p) ? 0 : p * q);
    }, 0);
    const desc = parseBRL(f.discount.value) || 0;
    $('[data-resumo]', f).innerHTML = `<span>Produtos</span><span class="right">${brl(sub)}</span><span>Desconto</span><span class="right">− ${brl(desc)}</span>
      <span class="tot">Total</span><span class="right tot">${brl(sub - desc)}</span>`;
  };
  f.addEventListener('change', (e) => {
    if (e.target.matches('[data-prod]')) {
      const row = e.target.closest('[data-item]');
      const p = prods.find((x) => String(x.id) === e.target.value);
      if (p) {
        $('[data-preco]', row).value = p.price_cents ? moneyIn(p.price_cents) : '';
        if (p.price_pending) toast(`Preço de ${p.sku} ainda não confirmado — digite o preço praticado.`, true);
      }
      moneyGuard(row); resumo();
    }
  });
  f.addEventListener('input', resumo);
  f.addEventListener('click', (e) => {
    if (e.target.matches('[data-add]')) { $('[data-itens]', f).insertAdjacentHTML('beforeend', itemRow()); moneyGuard(f); }
    if (e.target.matches('[data-rm]')) { if ($$('[data-item]', f).length > 1) e.target.closest('[data-item]').remove(); resumo(); }
  });
  $('[data-status]', f)?.addEventListener('click', (e) => run(e.target, async () => {
    if (v.status === 'ativo' && !confirm('Cancelar esta venda? Os produtos voltam ao estoque; a venda continua no histórico.')) return;
    await POST(`/balcao/${v.id}/${v.status === 'ativo' ? 'cancelar' : 'reativar'}`);
    toast('Venda atualizada.'); s.close(); onSaved();
  }));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (hasInvalid(f)) return;
    const items = $$('[data-item]', f).map((row) => ({ id: row.dataset.id ? Number(row.dataset.id) : undefined,
      product_id: $('[data-prod]', row).value, qty: $('[data-qtd]', row).value, price: $('[data-preco]', row).value }));
    const body = { date: f.date.value, seller_barber_id: f.seller_barber_id.value || null, payment_method: f.payment_method.value,
      items, discount: f.discount.value, received: f.received.value, note: f.note.value };
    run($('button[type=submit]', f), async () => {
      const r = await (v ? PUT(`/balcao/${v.id}`, body) : POST('/balcao', body));
      toast(r.avisos?.length ? r.avisos.join(' ') : 'Venda registrada — estoque atualizado.', !!r.avisos?.length);
      s.close(); onSaved();
    });
  });
  moneyGuard(f); resumo();
}

function onlineForm(o = null, onSaved) {
  const prods = ref.produtos;
  const itemRow = (it = {}) => `<div class="item prod" data-item>
      <label>SKU<select data-sku required>${opts(prods, { value: 'sku', selected: it.sku, empty: 'Selecione…', label: prodLabel })}${it.sku && !prods.find((p) => p.sku === it.sku) ? `<option value="${esc(it.sku)}" selected>${esc(it.sku)} (não cadastrado)</option>` : ''}</select></label>
      <label>Qtd<input data-int data-qtd value="${esc(it.qty ?? 1)}"></label>
      <label>Preço unit.<input data-money data-preco value="${esc(it.unit_price_cents !== undefined ? moneyIn(it.unit_price_cents) : '')}" placeholder="0,00"></label>
      <button type="button" class="btn fantasma rm" data-rm title="Remover">×</button></div>`;
  const s = sheet(o ? `${CANAIS[o.channel]} — pedido ${o.order_number}` : 'Novo pedido online', `
    <form class="form" data-f>
      <div class="linha c3">
        <label>Canal<select name="channel" ${o ? 'disabled' : ''} required>${Object.entries(CANAIS).map(([k, l]) => `<option value="${k}" ${o?.channel === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Número do pedido<input name="order_number" value="${esc(o?.order_number || '')}" ${o ? 'disabled' : ''} required></label>
        <label>Data da venda<input type="date" name="date" value="${esc(o?.date || today())}" required></label>
      </div>
      <div class="linha c2">
        <label>Status<select name="status">${Object.entries(STATUS_ON).map(([k, l]) => `<option value="${k}" ${(o?.status || 'pago') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="restock_on_return" ${o ? (o.restock_on_return ? 'checked' : '') : (ref.config.return_restock_default ? 'checked' : '')}> Em devolução, o produto volta ao estoque</label>
      </div>
      <div class="itens" data-itens>${o ? o.items.map(itemRow).join('') : itemRow()}</div>
      <button type="button" class="btn fantasma" data-add>+ Adicionar item</button>
      <div class="linha c3">
        <label>Valor bruto<input data-money name="gross" value="${esc(o ? moneyIn(o.gross_cents) : '')}" placeholder="= soma dos itens"></label>
        <label>Taxas/comissão cobradas<input data-money name="fees" value="${esc(o ? moneyIn(o.fees_cents) : '')}" placeholder="0,00"></label>
        <label>Frete pago por você<input data-money name="shipping" value="${esc(o ? moneyIn(o.shipping_cents) : '')}" placeholder="0,00"></label>
      </div>
      <div class="linha c3">
        <label>Descontos/cupons<input data-money name="discount" value="${esc(o ? moneyIn(o.discount_cents) : '')}" placeholder="0,00"></label>
        <label>Valor líquido<input data-money name="net" value="${esc(o ? moneyIn(o.net_cents) : '')}" placeholder="calculado"><span class="hint">use o valor do extrato do canal</span></label>
        <label>Data do repasse<input type="date" name="payout_date" value="${esc(o?.payout_date || '')}"><span class="hint">quando o dinheiro caiu</span></label>
      </div>
      <label>Observação<textarea name="note">${esc(o?.note || '')}</textarea></label>
      <div class="resumo" data-resumo></div>
      <div class="acoes"><button class="btn primario" type="submit">${o ? 'Salvar alterações' : 'Registrar pedido'}</button></div>
    </form>`);
  const f = $('[data-f]', s.el);
  const resumo = () => {
    const itens = $$('[data-item]', f).reduce((t, row) => t + (Number($('[data-qtd]', row).value) || 0) * (parseBRL($('[data-preco]', row).value) || 0), 0);
    const g = f.gross.value.trim() ? parseBRL(f.gross.value) : itens;
    const liq = (g || 0) - (parseBRL(f.fees.value) || 0) - (parseBRL(f.shipping.value) || 0) - (parseBRL(f.discount.value) || 0);
    $('[data-resumo]', f).innerHTML = `<span>Bruto</span><span class="right">${brl(g)}</span><span class="muted">Líquido calculado</span><span class="right muted">${brl(liq)}</span>
      ${f.net.value.trim() ? `<span>Líquido informado</span><span class="right">${brl(parseBRL(f.net.value) || 0)}</span>` : ''}`;
  };
  f.addEventListener('change', (e) => {
    if (e.target.matches('[data-sku]')) {
      const p = prods.find((x) => x.sku === e.target.value); const row = e.target.closest('[data-item]');
      if (p && !$('[data-preco]', row).value) $('[data-preco]', row).value = p.price_cents ? moneyIn(p.price_cents) : '';
      moneyGuard(row); resumo();
    }
  });
  f.addEventListener('input', resumo);
  f.addEventListener('click', (e) => {
    if (e.target.matches('[data-add]')) { $('[data-itens]', f).insertAdjacentHTML('beforeend', itemRow()); moneyGuard(f); }
    if (e.target.matches('[data-rm]')) { if ($$('[data-item]', f).length > 1) e.target.closest('[data-item]').remove(); resumo(); }
  });
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (hasInvalid(f)) return;
    const body = { channel: f.channel.value, order_number: f.order_number.value, date: f.date.value, status: f.status.value,
      restock_on_return: f.restock_on_return.checked,
      items: $$('[data-item]', f).map((row) => ({ sku: $('[data-sku]', row).value, qty: $('[data-qtd]', row).value, unit_price: $('[data-preco]', row).value })),
      gross: f.gross.value, fees: f.fees.value, shipping: f.shipping.value, discount: f.discount.value, net: f.net.value,
      payout_date: f.payout_date.value || null, note: f.note.value };
    run($('button[type=submit]', f), async () => {
      await (o ? PUT(`/online/${o.id}`, body) : POST('/online', body));
      toast(o ? 'Pedido atualizado — estoque ajustado conforme o status.' : 'Pedido registrado — estoque baixado.'); s.close(); onSaved();
    });
  });
  moneyGuard(f); resumo();
}

PAGES.vendas = async (main, sub) => {
  setTitle('Vendas');
  const tab = ['balcao', 'online', 'importar'].includes(sub) ? sub : 'balcao';
  await loadProdutos();
  main.innerHTML = `<div class="page-head"><h1>Vendas</h1></div>
    <div class="tabs">${[['balcao', 'Balcão (barbearia)'], ['online', 'Online'], ['importar', 'Importar arquivo']].map(([k, l]) => `<a class="tab ${tab === k ? 'ativo' : ''}" href="#/vendas/${k}">${l}</a>`).join('')}</div>
    <div data-body></div>`;
  const body = $('[data-body]', main);
  if (tab === 'balcao') {
    body.innerHTML = `<div class="page-head"><span class="faint">Venda de produto separada de serviço. Baixa o mesmo estoque das vendas online (por SKU).</span><button class="btn primario" data-novo>+ Nova venda</button></div>
      <div data-pb></div><div class="card"><div class="page-head"><span class="faint" data-tot></span></div><div class="list" data-list></div></div>`;
    const load = async () => {
      const per = (await GET('/relatorio?' + periodoQS())).periodo;
      const rows = await GET(`/balcao?inicio=${per.inicio}&fim=${per.fim}`);
      const at = rows.filter((r) => r.status === 'ativo');
      $('[data-tot]', body).textContent = `${periodoLabel(per)} · ${at.length} venda(s) · ${brl(at.reduce((t, r) => t + r.total_cents, 0))}`;
      $('[data-list]', body).innerHTML = rows.length ? rows.map((r) => `<div class="row click ${r.status}" data-id="${r.id}">
        <div class="main"><div class="t">${esc(r.items.map((i) => `${i.qty}× ${i.product_name}`).join(', '))}</div>
        <div class="s">${brDate(r.date)} · ${esc(r.payment_method)}${r.seller_name ? ` · ${esc(r.seller_name)}` : ''}${r.status === 'cancelado' ? ' · <span class="badge red">cancelada</span>' : ''}</div></div>
        <div class="v">${brl(r.total_cents)}</div></div>`).join('') : '<p class="empty">Nenhuma venda de balcão no período.</p>';
    };
    const reload = async () => { await loadProdutos(); await load(); };
    $('[data-pb]', body).appendChild(periodoBar(load, { hoje: true }));
    $('[data-novo]', body).addEventListener('click', () => balcaoForm(null, reload));
    $('[data-list]', body).addEventListener('click', async (e) => { const r = e.target.closest('[data-id]'); if (r) balcaoForm(await GET(`/balcao/${r.dataset.id}`), reload); });
    await load();
  }
  if (tab === 'online') {
    const fil = { canal: '', status: '' };
    body.innerHTML = `<div class="page-head"><div class="chips" data-canais>${[['', 'Todos'], ...Object.entries(CANAIS)].map(([k, l]) => `<button class="chip ${k === '' ? 'ativo' : ''}" data-c="${k}">${l}</button>`).join('')}</div>
        <button class="btn primario" data-novo>+ Novo pedido</button></div>
      <div data-pb></div>
      <div class="card"><div class="page-head"><select class="chip" data-st><option value="">Todos os status</option>${Object.entries(STATUS_ON).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><span class="faint" data-tot></span></div>
      <div class="list" data-list></div></div>`;
    const load = async () => {
      const per = (await GET('/relatorio?' + periodoQS())).periodo;
      const rows = await GET(`/online?inicio=${per.inicio}&fim=${per.fim}${fil.canal ? `&canal=${fil.canal}` : ''}${fil.status ? `&status=${fil.status}` : ''}`);
      const val = rows.filter((r) => ['pago', 'enviado', 'entregue'].includes(r.status));
      $('[data-tot]', body).textContent = `${periodoLabel(per)} · ${val.length} pedido(s) válidos · bruto ${brl(val.reduce((t, r) => t + r.gross_cents, 0))}`;
      $('[data-list]', body).innerHTML = rows.length ? rows.map((r) => `<div class="row click ${['cancelado'].includes(r.status) ? 'cancelado' : ''}" data-id="${r.id}">
        <div class="main"><div class="t">${esc(CANAIS[r.channel])} · ${esc(r.order_number)}</div>
        <div class="s">${brDate(r.date)} · ${esc(r.items.map((i) => `${i.qty}× ${i.sku}`).join(', '))}
          · <span class="badge ${r.status === 'cancelado' || r.status === 'devolvido' ? 'red' : r.status === 'entregue' ? 'green' : 'blue'}">${STATUS_ON[r.status]}</span>
          ${r.payout_date ? `<span class="badge green">repasse ${brDate(r.payout_date)}</span>` : (['pago', 'enviado', 'entregue'].includes(r.status) ? '<span class="badge amber">a receber</span>' : '')}
          ${r.items.some((i) => !i.product_id) ? '<span class="badge red">SKU não cadastrado</span>' : ''}</div></div>
        <div class="v">${brl(r.gross_cents)}<div class="faint right">líq. ${brl(r.net_cents)}</div></div></div>`).join('') : '<p class="empty">Nenhum pedido no período.</p>';
    };
    const reload = async () => { await loadProdutos(); await load(); };
    $('[data-pb]', body).appendChild(periodoBar(load));
    $('[data-canais]', body).addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; fil.canal = b.dataset.c; $$('[data-c]', body).forEach((x) => x.classList.toggle('ativo', x === b)); load(); });
    $('[data-st]', body).addEventListener('change', (e) => { fil.status = e.target.value; load(); });
    $('[data-novo]', body).addEventListener('click', () => onlineForm(null, reload));
    $('[data-list]', body).addEventListener('click', async (e) => { const r = e.target.closest('[data-id]'); if (r) onlineForm(await GET(`/online/${r.dataset.id}`), reload); });
    await load();
  }
  if (tab === 'importar') {
    const lotes = await GET('/online/lotes');
    body.innerHTML = `<div class="grid grid-2">
      <div class="card form" data-f>
        <h2>Importar pedidos (CSV)</h2>
        <div class="alert blue">A conexão automática com Mercado Livre, Shopee, TikTok Shop e Amazon <strong>ainda não está ligada</strong> — ela precisa das credenciais oficiais de cada loja (veja “Pendências”). Por enquanto: exporte o relatório de vendas do canal em CSV e importe aqui, ou lance manualmente.</div>
        <label>Canal<select name="channel">${Object.entries(CANAIS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label>Arquivo CSV<input type="file" name="arquivo" accept=".csv,text/csv"></label>
        <p class="hint">Uma linha por item. Colunas obrigatórias: número do pedido, data, SKU e quantidade. Reimportar o mesmo arquivo não duplica vendas nem baixa o estoque de novo — só atualiza o que mudou (status, repasse, valores).</p>
        <div class="acoes"><a class="btn fantasma" href="/api/online/modelo.csv">Baixar modelo</a><button class="btn primario" data-imp>Importar</button></div>
        <div data-res></div>
      </div>
      <div class="card"><h3>Últimas importações</h3><div class="list">${lotes.length ? lotes.map((l) => `<div class="row"><div class="main"><div class="t">${esc(CANAIS[l.channel])} · ${esc(l.filename || 'arquivo')}</div>
        <div class="s">${brDateTime(l.created_at)} · ${l.created_orders} novo(s), ${l.updated_orders} atualizado(s), ${l.unchanged_orders} sem alteração, ${JSON.parse(l.errors_json || '[]').length} com erro</div></div></div>`).join('') : '<p class="empty">Nenhuma importação ainda.</p>'}</div></div></div>`;
    const f = $('[data-f]', body);
    $('[data-imp]', f).addEventListener('click', (e) => run(e.target, async () => {
      const file = f.querySelector('[name=arquivo]').files[0];
      if (!file) return toast('Escolha o arquivo CSV.', true);
      if (file.size > 5 * 1024 * 1024) return toast('Arquivo grande demais (máx. 5 MB).', true);
      const buf = await file.arrayBuffer();
      let csv = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (csv.includes('�')) csv = new TextDecoder('windows-1252').decode(buf); // planilhas salvas em ANSI
      const r = await POST('/online/importar', { channel: f.querySelector('[name=channel]').value, filename: file.name, csv });
      $('[data-res]', f).innerHTML = `<div class="alert ${r.erros.length ? 'amber' : 'blue'}"><strong>${r.linhas} linha(s) lidas:</strong> ${r.criados} pedido(s) novo(s), ${r.atualizados} atualizado(s), ${r.sem_alteracao} já estavam iguais.
        ${r.erros.length ? `<br><strong>${r.erros.length} pedido(s) recusado(s) — nada deles foi gravado:</strong><br>${r.erros.map((x) => `Linha(s) ${x.linhas.join(', ')} (pedido ${esc(x.pedido)}): ${esc(x.erro)}`).join('<br>')}` : ''}
        ${r.avisos.length ? `<br><strong>Avisos:</strong><br>${r.avisos.map(esc).join('<br>')}` : ''}</div>`;
      await loadProdutos();
    }));
  }
};

// ============================== ESTOQUE ==============================
function produtoForm(p = null, onSaved) {
  const s = sheet(p ? `${p.sku} — ${p.name}` : 'Novo produto', `
    <form class="form" data-f>
      ${p?.price_pending || p?.cost_pending ? `<div class="alert amber">Veio da planilha com ${[p.price_pending && 'preço', p.cost_pending && 'custo'].filter(Boolean).join(' e ')} zerado/não confirmado. Informe o valor certo e salve.</div>` : ''}
      <div class="linha c2">
        <label>SKU (único em todos os canais)<input name="sku" value="${esc(p?.sku || '')}" required></label>
        <label>Nome<input name="name" value="${esc(p?.name || '')}" required></label>
      </div>
      <div class="linha c3">
        <label>Categoria<select name="category">${opts(ref.catProduto, { value: 'name', selected: p?.category, empty: '—' })}</select></label>
        <label>Custo unitário<input data-money name="cost" value="${esc(p ? moneyIn(p.cost_cents) : '')}" placeholder="0,00"></label>
        <label>Preço de venda<input data-money name="price" value="${esc(p ? moneyIn(p.price_cents) : '')}" placeholder="0,00"></label>
      </div>
      <div class="linha c3">
        <label>Estoque mínimo<input data-int name="min_stock" value="${esc(p?.min_stock ?? 0)}"></label>
        ${p ? `<label>Saldo atual<input value="${esc(p.saldo)}" disabled><span class="hint">muda só por entrada, ajuste ou venda</span></label>` : '<label>Estoque inicial<input data-int name="estoque_inicial" value="0"></label>'}
        <label>Fornecedor<input name="supplier" value="${esc(p?.supplier || '')}"></label>
      </div>
      <label>Observações<textarea name="notes">${esc(p?.notes || '')}</textarea></label>
      ${p ? `<label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Produto ativo</label>` : ''}
      <div class="acoes">${p ? '<button type="button" class="btn fantasma" data-entrada>+ Entrada / compra</button><button type="button" class="btn fantasma" data-ajuste>Ajuste</button>' : ''}
        <button class="btn primario" type="submit">Salvar</button></div>
    </form>
    ${p ? `<h3 class="mt">Movimentações</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Data</th><th>Tipo</th><th class="n">Qtd</th><th>Origem</th></tr></thead><tbody>
      ${p.movimentacoes.map((m) => `<tr><td class="nowrap">${brDate(m.date)}</td><td>${esc(MOV[m.kind] || m.kind)}</td><td class="n">${m.qty > 0 ? '+' : ''}${m.qty}</td><td class="faint">${esc(m.note || m.source || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Sem movimentações.</td></tr>'}
      </tbody></table></div>` : ''}`);
  const f = $('[data-f]', s.el);
  moneyGuard(f);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (hasInvalid(f)) return;
    const body = { sku: f.sku.value, name: f.name.value, category: f.category.value || null,
      min_stock: f.min_stock.value || '0', supplier: f.supplier.value, notes: f.notes.value };
    // só envia custo/preço se mudou (ou se não estava pendente): assim "a confirmar" só sai quando você informa o valor
    if (!p || !p.cost_pending || f.cost.value !== moneyIn(p.cost_cents)) body.cost = f.cost.value || '0';
    if (!p || !p.price_pending || f.price.value !== moneyIn(p.price_cents)) body.price = f.price.value || '0';
    if (p) body.active = f.active.checked; else body.estoque_inicial = f.estoque_inicial.value;
    run($('button[type=submit]', f), async () => {
      await (p ? PUT(`/produtos/${p.id}`, body) : POST('/produtos', body));
      toast('Produto salvo.'); s.close(); onSaved();
    });
  });
  $('[data-entrada]', f)?.addEventListener('click', () => { s.close(); movForm(p, 'entrada', onSaved); });
  $('[data-ajuste]', f)?.addEventListener('click', () => { s.close(); movForm(p, 'ajuste', onSaved); });
}
const MOV = { saldo_inicial: 'Saldo inicial', compra: 'Compra/entrada', ajuste: 'Ajuste', venda_balcao: 'Venda balcão', venda_online: 'Venda online',
  cancelamento: 'Cancelamento', devolucao: 'Devolução', estorno: 'Estorno' };

function movForm(p, tipo, onSaved) {
  const s = sheet(`${tipo === 'entrada' ? 'Entrada / compra' : 'Ajuste de estoque'} — ${p.sku}`, `
    <form class="form" data-f><p class="muted">${esc(p.name)} · saldo atual <strong>${p.saldo}</strong></p>
      <div class="linha c3"><label>Data<input type="date" name="date" value="${today()}"></label>
        <label>${tipo === 'entrada' ? 'Quantidade comprada' : 'Quantidade (+ entra, − sai)'}<input data-int name="qty" required></label>
        ${tipo === 'entrada' ? `<label>Custo unitário<input data-money name="unit_cost" value="${esc(moneyIn(p.cost_cents))}"></label>` : '<span></span>'}</div>
      <label>${tipo === 'entrada' ? 'Observação (fornecedor, nota…)' : 'Motivo (obrigatório: contagem, perda, quebra…)'}<textarea name="note" ${tipo === 'ajuste' ? 'required' : ''}></textarea></label>
      ${tipo === 'entrada' ? `<label class="check"><input type="checkbox" name="registrar_saida"> Registrar também como saída de caixa (compra paga agora)</label>
        <div class="linha c2 hidden" data-saida><label>Forma de pagamento<select name="payment_method">${opts(ref.pagamentos, { value: 'name', empty: '—' })}</select></label>
        <label>Responsável<select name="responsible">${opts(ref.responsaveis, { value: 'name', empty: '—' })}</select></label></div>` : ''}
      <div class="acoes"><button class="btn primario" type="submit">Salvar</button></div></form>`);
  const f = $('[data-f]', s.el);
  moneyGuard(f);
  f.registrar_saida?.addEventListener('change', () => $('[data-saida]', f).classList.toggle('hidden', !f.registrar_saida.checked));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (hasInvalid(f)) return;
    const body = { product_id: p.id, date: f.date.value, qty: f.qty.value, note: f.note.value };
    if (tipo === 'entrada') Object.assign(body, { unit_cost: f.unit_cost.value, registrar_saida: f.registrar_saida.checked, payment_method: f.payment_method.value, responsible: f.responsible.value });
    run($('button[type=submit]', f), async () => {
      const r = await POST(tipo === 'entrada' ? '/estoque/entrada' : '/estoque/ajuste', body);
      toast(`Estoque de ${p.sku} agora: ${r.saldo}.`); s.close(); onSaved();
    });
  });
}

PAGES.estoque = async (main, sub) => {
  setTitle('Estoque');
  const st = { filtro: ['baixo', 'confirmar'].includes(sub) ? sub : 'todos', busca: '' };
  main.innerHTML = `<div class="page-head"><h1>Produtos e estoque</h1><button class="btn primario" data-novo>+ Novo produto</button></div>
    <div class="card stack"><input type="search" placeholder="Buscar por SKU ou nome…" data-busca>
      <div class="chips">${[['todos', 'Todos'], ['baixo', 'Estoque baixo'], ['confirmar', 'Preço/custo a confirmar'], ['inativos', 'Inativos']].map(([k, l]) => `<button class="chip ${st.filtro === k ? 'ativo' : ''}" data-fil="${k}">${l}</button>`).join('')}</div>
      <div class="list" data-list></div></div>`;
  let todos = [];
  const draw = () => {
    const q = st.busca.toLowerCase();
    const rows = todos.filter((p) => (st.filtro === 'inativos' ? !p.active : p.active))
      .filter((p) => st.filtro !== 'baixo' || p.saldo <= p.min_stock)
      .filter((p) => st.filtro !== 'confirmar' || p.price_pending || p.cost_pending)
      .filter((p) => !q || p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    $('[data-list]', main).innerHTML = rows.length ? rows.map((p) => `<div class="row click" data-id="${p.id}">
      <div class="main"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.sku)} · ${esc(p.category || '—')} · ${brl(p.price_cents)}
        ${p.price_pending ? '<span class="badge amber">preço a confirmar</span>' : ''}${p.cost_pending ? '<span class="badge amber">custo a confirmar</span>' : ''}</div></div>
      <div class="v"><span class="badge ${p.saldo <= p.min_stock ? 'red' : 'green'}">${p.saldo} un.</span><div class="faint right">mín. ${p.min_stock}</div></div></div>`).join('') : '<p class="empty">Nenhum produto.</p>';
  };
  const load = async () => { todos = await GET('/produtos?todos=1'); ref.produtos = todos.filter((p) => p.active); draw(); };
  $('[data-busca]', main).addEventListener('input', (e) => { st.busca = e.target.value; draw(); });
  main.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-fil]');
    if (c) { st.filtro = c.dataset.fil; $$('[data-fil]', main).forEach((x) => x.classList.toggle('ativo', x === c)); draw(); }
    const r = e.target.closest('[data-list] [data-id]');
    if (r) produtoForm(await GET(`/produtos/${r.dataset.id}`), load);
  });
  $('[data-novo]', main).addEventListener('click', () => produtoForm(null, load));
  await load();
};

// ============================== FINANCEIRO ==============================
PAGES.financeiro = async (main, sub) => {
  setTitle('Financeiro');
  const tabs = [['contas', 'Contas a pagar'], ['saidas', 'Saídas'], ['relatorio', 'Relatório'], ['fechamentos', 'Fechamentos'], ['caixa', 'Caixa e bancos']];
  const tab = tabs.find(([k]) => k === sub) ? sub : 'contas';
  main.innerHTML = `<div class="page-head"><h1>Financeiro</h1></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${tab === k ? 'ativo' : ''}" href="#/financeiro/${k}">${l}</a>`).join('')}</div><div data-body></div>`;
  await FIN[tab]($('[data-body]', main));
};
const FIN = {};

FIN.contas = async (body) => {
  body.innerHTML = `<div class="page-head"><span class="faint">Conta paga vira UMA saída de caixa (não conta duas vezes).</span><button class="btn primario" data-nova>+ Nova conta</button></div><div data-list class="stack"></div>`;
  const load = async () => {
    const rows = await GET('/contas');
    const t = today();
    const grupos = [
      ['A confirmar (vieram da planilha e parecem exemplo)', rows.filter((c) => c.needs_review)],
      ['Vencidas', rows.filter((c) => !c.needs_review && c.status === 'pendente' && c.due_date < t)],
      ['A pagar', rows.filter((c) => !c.needs_review && c.status === 'pendente' && c.due_date >= t)],
      ['Pagas', rows.filter((c) => !c.needs_review && c.status === 'pago').slice(-30).reverse()],
      ['Canceladas', rows.filter((c) => !c.needs_review && c.status === 'cancelado').slice(-10)],
    ].filter(([, l]) => l.length);
    $('[data-list]', body).innerHTML = grupos.length ? grupos.map(([nome, l]) => `<div class="card"><h3>${nome} (${l.length})</h3><div class="list">${l.map((c) => `
      <div class="row click" data-id="${c.id}"><div class="main"><div class="t">${esc(c.description)}</div>
      <div class="s">vence ${brDate(c.due_date)}${c.category ? ` · ${esc(c.category)}` : ''}${c.status === 'pago' ? ` · pago em ${brDate(c.paid_date)}` : ''}
      ${c.status === 'pendente' && c.due_date < t ? '<span class="badge red">vencida</span>' : ''}${c.needs_review ? '<span class="badge amber">a confirmar</span>' : ''}</div></div>
      <div class="v">${brl(c.amount_cents)}</div></div>`).join('')}</div></div>`).join('') : '<div class="card"><p class="empty">Nenhuma conta cadastrada.</p></div>';
  };
  const form = (c = null) => {
    const s = sheet(c ? 'Conta a pagar' : 'Nova conta a pagar', `<form class="form" data-f>
      ${c?.needs_review ? `<div class="alert amber">Importada da planilha — parece exemplo. ${esc(c.note || '')}<br>Se for real, confirme. Se não for, cancele.</div>` : ''}
      ${c?.status === 'pago' ? `<div class="alert blue">Paga em ${brDate(c.paid_date)} (${esc(c.payment_method || '—')}). A saída de caixa já está registrada uma vez.</div>` : ''}
      <label>Descrição<input name="description" value="${esc(c?.description || '')}" required></label>
      <div class="linha c2"><label>Fornecedor<input name="supplier" value="${esc(c?.supplier || '')}"></label>
        <label>Categoria<select name="category">${opts(ref.catDespesa, { value: 'name', selected: c?.category, empty: '—' })}</select></label></div>
      <div class="linha c2"><label>Valor<input data-money name="amount" value="${esc(c ? moneyIn(c.amount_cents) : '')}" required></label>
        <label>Vencimento<input type="date" name="due_date" value="${esc(c?.due_date || today())}" required></label></div>
      <label>Observações<textarea name="note">${esc(c?.note || '')}</textarea></label>
      <div class="acoes">
        ${c?.needs_review ? '<button type="button" class="btn azul" data-a="confirmar">Confirmar (é real)</button>' : ''}
        ${c && c.status === 'pendente' ? '<button type="button" class="btn fantasma" data-a="cancelar">Cancelar conta</button>' : ''}
        ${c && c.status === 'pago' ? '<button type="button" class="btn fantasma" data-a="desfazer-pagamento">Desfazer pagamento</button>' : ''}
        <button class="btn fantasma" type="submit">Salvar</button>
        ${c && c.status === 'pendente' && !c.needs_review ? '<button type="button" class="btn primario" data-pagar>Pagar</button>' : ''}
      </div>
      <div class="card hidden" data-pg><div class="linha c3">
        <label>Pago em<input type="date" name="paid_date" value="${today()}"></label>
        <label>Forma<select name="payment_method">${opts(ref.pagamentos, { value: 'name', empty: '—' })}</select></label>
        <label>Responsável<select name="responsible">${opts(ref.responsaveis, { value: 'name', empty: '—' })}</select></label></div>
        <div class="acoes"><button type="button" class="btn primario" data-conf-pg>Confirmar pagamento</button></div></div>
    </form>`);
    const f = $('[data-f]', s.el);
    moneyGuard(f);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (hasInvalid(f)) return;
      const b = { description: f.description.value, supplier: f.supplier.value, category: f.category.value || null, amount: f.amount.value, due_date: f.due_date.value, note: f.note.value };
      run($('button[type=submit]', f), async () => { await (c ? PUT(`/contas/${c.id}`, b) : POST('/contas', b)); toast('Conta salva.'); s.close(); load(); });
    });
    f.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]');
      if (a) run(a, async () => { await POST(`/contas/${c.id}/${a.dataset.a}`); toast('Conta atualizada.'); s.close(); load(); });
      if (e.target.matches('[data-pagar]')) $('[data-pg]', f).classList.remove('hidden');
      if (e.target.matches('[data-conf-pg]')) run(e.target, async () => {
        await POST(`/contas/${c.id}/pagar`, { paid_date: f.paid_date.value, payment_method: f.payment_method.value, responsible: f.responsible.value });
        toast('Conta paga — saída registrada.'); s.close(); load();
      });
    });
  };
  $('[data-nova]', body).addEventListener('click', () => form());
  $('[data-list]', body).addEventListener('click', async (e) => {
    const r = e.target.closest('[data-id]');
    if (r) form((await GET('/contas')).find((c) => String(c.id) === r.dataset.id));
  });
  await load();
};

FIN.saidas = async (body) => {
  body.innerHTML = `<div class="page-head"><span class="faint">Cada compra ou gasto é lançado individualmente.</span><button class="btn primario" data-nova>+ Nova saída</button></div>
    <div data-pb></div><div class="card"><div class="page-head"><span class="faint" data-tot></span></div><div class="list" data-list></div></div>`;
  let rows = [];
  const load = async () => {
    const per = (await GET('/relatorio?' + periodoQS())).periodo;
    rows = await GET(`/saidas?inicio=${per.inicio}&fim=${per.fim}`);
    const at = rows.filter((r) => r.status === 'ativo' && !r.needs_review);
    $('[data-tot]', body).textContent = `${periodoLabel(per)} · ${at.length} saída(s) · ${brl(at.reduce((t, r) => t + r.amount_cents, 0))}`;
    $('[data-list]', body).innerHTML = rows.length ? rows.map((r) => `<div class="row click ${r.status}" data-id="${r.id}">
      <div class="main"><div class="t">${esc(r.description)}</div><div class="s">${brDate(r.date)}${r.category ? ` · ${esc(r.category)}` : ''}${r.responsible ? ` · ${esc(r.responsible)}` : ''}${r.payment_method ? ` · ${esc(r.payment_method)}` : ''}
      ${r.payable_id ? '<span class="badge blue">conta paga</span>' : ''}${r.needs_review ? '<span class="badge amber">a confirmar</span>' : ''}${r.receipt_path ? '<span class="badge">comprovante</span>' : ''}${r.status === 'cancelado' ? '<span class="badge red">cancelada</span>' : ''}</div></div>
      <div class="v">${brl(r.amount_cents)}</div></div>`).join('') : '<p class="empty">Nenhuma saída no período.</p>';
  };
  const form = (o = null) => {
    const vinculada = !!o?.payable_id;
    const s = sheet(o ? 'Saída de caixa' : 'Nova saída de caixa', `<form class="form" data-f>
      ${vinculada ? '<div class="alert blue">Esta saída veio de uma conta paga. Valor e data se corrigem pela conta, em "Contas a pagar".</div>' : ''}
      ${o?.needs_review ? '<div class="alert amber">Importada da planilha — confirme se for real.</div>' : ''}
      <div class="linha c2"><label>Data<input type="date" name="date" value="${esc(o?.date || today())}" ${vinculada ? 'disabled' : ''}></label>
        <label>Valor<input data-money name="amount" value="${esc(o ? moneyIn(o.amount_cents) : '')}" ${vinculada ? 'disabled' : ''} required></label></div>
      <label>Descrição<input name="description" value="${esc(o?.description || '')}" required></label>
      <div class="linha c3"><label>Categoria<select name="category">${opts(ref.catDespesa, { value: 'name', selected: o?.category, empty: '—' })}</select></label>
        <label>Forma de pagamento<select name="payment_method">${opts(ref.pagamentos, { value: 'name', selected: o?.payment_method, empty: '—' })}</select></label>
        <label>Responsável<select name="responsible">${opts(ref.responsaveis, { value: 'name', selected: o?.responsible, empty: '—' })}</select></label></div>
      <label>Observação<textarea name="note">${esc(o?.note || '')}</textarea></label>
      <label>Comprovante (foto ou PDF, opcional)<input type="file" name="receipt" accept="image/jpeg,image/png,image/webp,application/pdf"></label>
      ${o?.receipt_path ? `<a href="/api/saidas/${o.id}/comprovante" target="_blank" rel="noopener">Ver comprovante atual</a>` : ''}
      <div class="acoes">
        ${o?.needs_review ? '<button type="button" class="btn azul" data-a="confirmar">Confirmar</button>' : ''}
        ${o && !vinculada ? `<button type="button" class="btn fantasma" data-a="${o.status === 'ativo' ? 'cancelar' : 'reativar'}">${o.status === 'ativo' ? 'Cancelar saída' : 'Reativar'}</button>` : ''}
        <button class="btn primario" type="submit">Salvar</button></div></form>`);
    const f = $('[data-f]', s.el);
    moneyGuard(f);
    f.addEventListener('click', (e) => { const a = e.target.closest('[data-a]'); if (a) run(a, async () => { await POST(`/saidas/${o.id}/${a.dataset.a}`); toast('Saída atualizada.'); s.close(); load(); }); });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (hasInvalid(f)) return;
      run($('button[type=submit]', f), async () => {
        const b = { description: f.description.value, category: f.category.value || null, payment_method: f.payment_method.value || null,
          responsible: f.responsible.value || null, note: f.note.value };
        if (!vinculada) Object.assign(b, { date: f.date.value, amount: f.amount.value });
        const file = f.receipt.files[0];
        if (file) {
          if (file.size > 4 * 1024 * 1024) throw new Error('Comprovante grande demais (máx. 4 MB).');
          b.receipt = { type: file.type, data: await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); }) };
        }
        await (o ? PUT(`/saidas/${o.id}`, b) : POST('/saidas', b));
        toast('Saída salva.'); s.close(); load();
      });
    });
  };
  $('[data-pb]', body).appendChild(periodoBar(load, { hoje: true }));
  $('[data-nova]', body).addEventListener('click', () => form());
  $('[data-list]', body).addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) form(rows.find((x) => String(x.id) === r.dataset.id)); });
  await load();
};

function relatorioHTML(r) {
  const tr = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="n">${brl(v)}</td></tr>`;
  return `<div class="grid grid-2">
    <div class="card"><h3>Vendas (pela data da venda)</h3><table class="tbl"><tbody>
      ${tr('Venda bruta', r.venda.bruto)}${tr('Descontos', -r.venda.descontos)}${tr('Taxas (maquininha, marketplaces e frete)', -r.venda.taxas)}${tr('Valor líquido', r.venda.liquido, 'total')}</tbody></table></div>
    <div class="card"><h3>Caixa (pela data em que o dinheiro entrou)</h3><table class="tbl"><tbody>
      ${tr('Serviços recebidos', r.caixa.servicos)}${tr('Balcão recebido', r.caixa.balcao)}${tr('Repasses online recebidos', r.caixa.repasses_online)}
      ${tr('Entradas', r.caixa.entradas, 'total')}${tr('Saídas', -r.caixa.saidas)}${tr('Resultado', r.caixa.resultado, 'total')}</tbody></table>
      <p class="faint">A receber dos marketplaces (sem repasse até ${brDate(r.periodo.fim)}): ${brl(r.online.a_receber)}</p></div></div>
    <div class="card"><h3>Serviços por barbeiro</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Barbeiro</th><th class="n">Atend.</th><th class="n">Bruto</th><th class="n">Total</th><th class="n">Recebido</th><th class="n">Comissão</th></tr></thead><tbody>
      ${r.servicos.por_barbeiro.map((b) => `<tr><td>${esc(b.name)}</td><td class="n">${b.atendimentos}</td><td class="n">${brl(b.bruto)}</td><td class="n">${brl(b.total)}</td><td class="n">${brl(b.recebido)}</td><td class="n">${brl(b.comissao)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td class="n">${r.servicos.n}</td><td class="n">${brl(r.servicos.bruto)}</td><td class="n">${brl(r.servicos.total)}</td><td class="n">${brl(r.servicos.recebido)}</td><td class="n">${brl(r.servicos.comissao)}</td></tr></tbody></table></div>
      ${r.servicos.cancelados.n ? `<p class="faint">${r.servicos.cancelados.n} atendimento(s) cancelado(s) (${brl(r.servicos.cancelados.valor)}) fora dos totais.</p>` : ''}</div>
    <div class="card"><h3>Vendas online por canal</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Canal</th><th class="n">Pedidos</th><th class="n">Bruto</th><th class="n">Taxas</th><th class="n">Frete</th><th class="n">Descontos</th><th class="n">Líquido</th><th class="n">Repasses</th><th class="n">A receber</th><th class="n">Cancel./Devol.</th></tr></thead><tbody>
      ${r.online.canais.map((c) => `<tr><td>${esc(c.nome)}</td><td class="n">${c.vendas.n}</td><td class="n">${brl(c.vendas.bruto)}</td><td class="n">${brl(c.vendas.taxas)}</td><td class="n">${brl(c.vendas.frete)}</td><td class="n">${brl(c.vendas.desconto)}</td><td class="n">${brl(c.vendas.liquido)}</td><td class="n">${brl(c.repasses.valor)}</td><td class="n">${brl(c.a_receber.valor)}</td><td class="n">${c.cancelados.n} / ${c.devolvidos.n}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td class="n">${r.online.n}</td><td class="n">${brl(r.online.bruto)}</td><td class="n">${brl(r.online.taxas)}</td><td class="n">${brl(r.online.frete)}</td><td class="n">${brl(r.online.desconto)}</td><td class="n">${brl(r.online.liquido)}</td><td class="n">${brl(r.online.repasses)}</td><td class="n">${brl(r.online.a_receber)}</td><td></td></tr></tbody></table></div></div>
    <div class="grid grid-2">
      <div class="card"><h3>Balcão</h3><table class="tbl"><tbody>${tr('Bruto', r.balcao.bruto)}${tr('Descontos', -r.balcao.desconto)}${tr('Taxa maquininha', -r.balcao.taxa)}${tr('Recebido', r.balcao.recebido, 'total')}</tbody></table>
        <p class="faint">${r.balcao.n} venda(s), ${r.balcao.itens} item(ns)${r.balcao.cancelados.n ? ` · ${r.balcao.cancelados.n} cancelada(s)` : ''}</p></div>
      <div class="card"><h3>Saídas por categoria</h3><table class="tbl"><tbody>${r.saidas.por_categoria.map((c) => tr(`${esc(c.categoria)} (${c.n})`, c.total)).join('') || '<tr><td class="empty">Sem saídas.</td></tr>'}
        ${tr('Total', r.saidas.total, 'total')}</tbody></table><p class="faint">Inclui ${r.saidas.contas_pagas.n} conta(s) paga(s) — cada uma contada uma vez.</p></div></div>`;
}

FIN.relatorio = async (body) => {
  body.innerHTML = `<div data-pb></div><div class="page-head"><span class="faint" data-per></span>
    <div class="acoes"><a class="btn pequeno fantasma" href="/api/exportar/atendimentos.csv">CSV atendimentos</a><a class="btn pequeno fantasma" href="/api/exportar/online.csv">CSV online</a><a class="btn pequeno fantasma" href="/api/exportar/saidas.csv">CSV saídas</a></div></div><div data-r class="stack"></div>`;
  const load = async () => {
    const r = await GET('/relatorio?' + periodoQS());
    $('[data-per]', body).textContent = periodoLabel(r.periodo);
    $('[data-r]', body).innerHTML = relatorioHTML(r);
  };
  $('[data-pb]', body).appendChild(periodoBar(load));
  await load();
};

FIN.fechamentos = async (body) => {
  const lista = await GET('/fechamentos');
  body.innerHTML = `<div class="grid grid-2">
    <form class="card form" data-f><h2>Fechar período</h2>
      <p class="hint">Fechar guarda uma “foto” dos números. Nada é apagado nem travado: correções continuam possíveis e ficam registradas; ao abrir o fechamento você vê o que mudou depois.</p>
      <div class="linha c2"><label>Tipo<select name="kind"><option value="semana">Semana (seg–dom)</option><option value="mes">Mês</option></select></label>
        <label>Data de referência<input type="date" name="ref" value="${today()}"></label></div>
      <div data-bonus><h3>Bônus por meta (% sobre a comissão)</h3>${ref.barbeiros.map((b) => `<label>${esc(b.name)}<input data-int name="bonus_${b.id}" placeholder="0"></label>`).join('')}</div>
      <label>Observação<textarea name="note"></textarea></label>
      <div class="acoes"><button class="btn fantasma" type="button" data-prev>Ver números</button><button class="btn primario" type="submit">Fechar período</button></div>
      <div data-prev-out></div></form>
    <div class="card"><h3>Fechamentos</h3><div class="list">${lista.length ? lista.map((c) => `<div class="row click" data-id="${c.id}"><div class="main"><div class="t">${c.kind === 'semana' ? 'Semana' : 'Mês'} ${brDate(c.start_date)} a ${brDate(c.end_date)}</div>
      <div class="s">fechado em ${brDateTime(c.closed_at)}${c.note ? ` · ${esc(c.note)}` : ''}</div></div></div>`).join('') : '<p class="empty">Nenhum fechamento ainda.</p>'}</div></div></div>`;
  const f = $('[data-f]', body);
  moneyGuard(f);
  const range = () => {
    const d = f.ref.value || today();
    return f.kind.value === 'semana' ? `periodo=semana&ref=${d}` : `periodo=mes&ref=${d}`;
  };
  $('[data-prev]', f).addEventListener('click', (e) => run(e.target, async () => {
    const r = await GET('/relatorio?' + range());
    $('[data-prev-out]', f).innerHTML = `<p class="muted">${periodoLabel(r.periodo)}</p>${relatorioHTML(r)}`;
  }));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (hasInvalid(f)) return;
    const bonus = {};
    ref.barbeiros.forEach((b) => { const v = f[`bonus_${b.id}`].value.trim(); if (v) bonus[b.id] = v; });
    run($('button[type=submit]', f), async () => {
      const c = await POST('/fechamentos', { kind: f.kind.value, ref: f.ref.value, bonus, note: f.note.value });
      toast(`Período ${brDate(c.start_date)} a ${brDate(c.end_date)} fechado.`);
      FIN.fechamentos(body);
    });
  });
  body.addEventListener('click', async (e) => {
    const r = e.target.closest('.row[data-id]');
    if (!r) return;
    const c = await GET(`/fechamentos/${r.dataset.id}`);
    const bonus = Object.values(c.bonus);
    sheet(`Fechamento ${brDate(c.start_date)} a ${brDate(c.end_date)}`, `
      ${c.diferencas.length ? `<div class="alert amber"><strong>Houve correções depois do fechamento:</strong><br>${c.diferencas.map((d) => `${esc(d.campo)}: ${brl(d.no_fechamento)} → ${brl(d.atual)}`).join('<br>')}
        <br><span class="faint">${c.alteracoes_depois.length} alteração(ões) registrada(s) no histórico.</span></div>` : '<div class="alert blue">Nenhuma alteração desde o fechamento.</div>'}
      ${bonus.length ? `<div class="card"><h3>Bônus</h3><table class="tbl"><tbody>${bonus.map((b) => `<tr><td>${esc(b.nome)} (${Math.round(b.pct * 100)}% de ${brl(b.comissao)})</td><td class="n">${brl(b.valor)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <h3>Números no fechamento</h3>${relatorioHTML(c.snapshot)}`);
  });
};

FIN.caixa = async (body) => {
  const d = await GET('/caixas');
  body.innerHTML = `<div class="stack">
    ${d.posicao ? `<div class="kpis"><div class="kpi"><div class="rot">Saldo estimado hoje</div><div class="val">${brl(d.posicao.saldo_estimado)}</div><div class="sub">desde ${brDate(d.posicao.desde)}</div></div>
      <div class="kpi"><div class="rot">Saldos iniciais</div><div class="val">${brl(d.posicao.saldo_inicial)}</div></div><div class="kpi"><div class="rot">Entradas</div><div class="val">${brl(d.posicao.entradas)}</div></div><div class="kpi"><div class="rot">Saídas</div><div class="val">${brl(d.posicao.saidas)}</div></div></div>`
      : '<div class="alert blue">Informe (ou confirme) o saldo inicial de cada banco/caixa para o app estimar o saldo atual.</div>'}
    <div class="card"><div class="page-head"><h3>Contas e caixa</h3><button class="btn pequeno primario" data-nova>+ Adicionar</button></div><div class="list">
      ${d.contas.map((c) => `<div class="row click" data-id="${c.id}"><div class="main"><div class="t">${esc(c.name)}</div><div class="s">saldo em ${brDate(c.opening_date)}${c.needs_review ? ' <span class="badge amber">veio da planilha — parece exemplo, confirme</span>' : ''}${c.active ? '' : ' <span class="badge">inativa</span>'}</div></div><div class="v">${brl(c.opening_cents)}</div></div>`).join('') || '<p class="empty">Nenhuma conta.</p>'}</div></div></div>`;
  const form = (c = null) => {
    const s = sheet(c ? c.name : 'Nova conta/caixa', `<form class="form" data-f>
      <label>Nome<input name="name" value="${esc(c?.name || '')}" required></label>
      <div class="linha c2"><label>Saldo na data<input data-money name="opening" value="${esc(c ? moneyIn(c.opening_cents) : '')}" required></label>
        <label>Data do saldo<input type="date" name="opening_date" value="${esc(c?.opening_date || today())}"></label></div>
      ${c ? `<label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Ativa</label>` : ''}
      <div class="acoes">${c?.needs_review ? '<button type="button" class="btn azul" data-conf>Confirmar saldo (é real)</button>' : ''}<button class="btn primario" type="submit">Salvar</button></div></form>`);
    const f = $('[data-f]', s.el);
    moneyGuard(f);
    const save = (extra = {}) => run($('button[type=submit]', f), async () => {
      if (hasInvalid(f)) return;
      const b = { name: f.name.value, opening: f.opening.value, opening_date: f.opening_date.value, ...extra };
      if (c) b.active = f.active.checked;
      await (c ? PUT(`/caixas/${c.id}`, b) : POST('/caixas', b));
      toast('Salvo.'); s.close(); FIN.caixa(body);
    });
    f.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    $('[data-conf]', f)?.addEventListener('click', () => save({ confirmar: true }));
  };
  $('[data-nova]', body).addEventListener('click', () => form());
  body.addEventListener('click', (e) => { const r = e.target.closest('.row[data-id]'); if (r) form(d.contas.find((x) => String(x.id) === r.dataset.id)); });
};

// ============================== CADASTROS ==============================
PAGES.cadastros = async (main, sub) => {
  setTitle('Cadastros');
  const tabs = [['barbeiros', 'Barbeiros'], ['servicos', 'Serviços'], ['listas', 'Listas'], ['config', 'Regras'], ['backup', 'Backup'], ['seguranca', 'Senha'], ['historico', 'Histórico']];
  const tab = tabs.find(([k]) => k === sub) ? sub : 'barbeiros';
  main.innerHTML = `<div class="page-head"><h1>Cadastros e configurações</h1></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${tab === k ? 'ativo' : ''}" href="#/cadastros/${k}">${l}</a>`).join('')}</div><div data-body></div>`;
  await CAD[tab]($('[data-body]', main));
};
const CAD = {};

CAD.barbeiros = async (body) => {
  await loadRefs(true);
  body.innerHTML = `<div class="card"><div class="page-head"><h3>Barbeiros</h3><button class="btn pequeno primario" data-novo>+ Adicionar</button></div>
    <p class="hint">Desativar tira o nome dos lançamentos novos, mas mantém todo o histórico e os relatórios.</p>
    <div class="list">${ref.barbeirosTodos.map((b) => `<div class="row click" data-id="${b.id}"><div class="main"><div class="t">${esc(b.name)}</div>
      <div class="s">comissão ${b.commission_pct === null ? `padrão (${Math.round(ref.config.commission_pct_default * 100)}%)` : `${Math.round(b.commission_pct * 100)}%`} · ${b.anotacoes} anotação(ões)${b.active ? '' : ' · <span class="badge">desativado</span>'}</div></div></div>`).join('')}</div></div>`;
  const form = (b = null) => {
    const s = sheet(b ? b.name : 'Novo barbeiro', `<form class="form" data-f>
      <div class="linha c2"><label>Nome<input name="name" value="${esc(b?.name || '')}" required></label>
        <label>% de comissão (vazio = padrão)<input name="commission_pct" value="${esc(b?.commission_pct === null || b?.commission_pct === undefined ? '' : Math.round(b.commission_pct * 10000) / 100)}" placeholder="${Math.round(ref.config.commission_pct_default * 100)}"></label></div>
      ${b ? `<label class="check"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> Ativo (aparece nos lançamentos)</label>` : ''}
      <div class="acoes"><button class="btn primario" type="submit">Salvar</button></div></form>
      ${b ? '<div class="card notas" data-notas></div>' : ''}`);
    const f = $('[data-f]', s.el);
    if (b) notasPanel($('[data-notas]', s.el), b.id);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = { name: f.name.value, commission_pct: f.commission_pct.value.trim() === '' ? null : f.commission_pct.value };
      if (b) d.active = f.active.checked;
      run($('button[type=submit]', f), async () => { await (b ? PUT(`/barbeiros/${b.id}`, d) : POST('/barbeiros', d)); toast('Barbeiro salvo.'); s.close(); CAD.barbeiros(body); });
    });
  };
  $('[data-novo]', body).addEventListener('click', () => form());
  body.addEventListener('click', (e) => { const r = e.target.closest('.row[data-id]'); if (r) form(ref.barbeirosTodos.find((x) => String(x.id) === r.dataset.id)); });
};

CAD.servicos = async (body) => {
  const lista = await GET('/servicos?todos=1');
  body.innerHTML = `<div class="card"><div class="page-head"><h3>Serviços e preços</h3><button class="btn pequeno primario" data-novo>+ Adicionar</button></div>
    <p class="hint">Mudar o preço aqui vale para os próximos atendimentos. Os atendimentos já lançados guardam o preço praticado.</p>
    <div class="list">${lista.map((s) => `<div class="row click" data-id="${s.id}"><div class="main"><div class="t">${esc(s.name)}</div>${s.active ? '' : '<div class="s"><span class="badge">desativado</span></div>'}</div><div class="v">${brl(s.price_cents)}</div></div>`).join('')}</div></div>`;
  const form = (sv = null) => {
    const s = sheet(sv ? sv.name : 'Novo serviço', `<form class="form" data-f><div class="linha c2">
      <label>Nome<input name="name" value="${esc(sv?.name || '')}" required></label><label>Preço<input data-money name="price" value="${esc(sv ? moneyIn(sv.price_cents) : '')}" required></label></div>
      ${sv ? `<label class="check"><input type="checkbox" name="active" ${sv.active ? 'checked' : ''}> Ativo</label>` : ''}
      <div class="acoes"><button class="btn primario" type="submit">Salvar</button></div></form>`);
    const f = $('[data-f]', s.el);
    moneyGuard(f);
    f.addEventListener('submit', (e) => {
      e.preventDefault(); if (hasInvalid(f)) return;
      const d = { name: f.name.value, price: f.price.value }; if (sv) d.active = f.active.checked;
      run($('button[type=submit]', f), async () => { await (sv ? PUT(`/servicos/${sv.id}`, d) : POST('/servicos', d)); await loadRefs(true); toast('Serviço salvo.'); s.close(); CAD.servicos(body); });
    });
  };
  $('[data-novo]', body).addEventListener('click', () => form());
  body.addEventListener('click', (e) => { const r = e.target.closest('.row[data-id]'); if (r) form(lista.find((x) => String(x.id) === r.dataset.id)); });
};

CAD.listas = async (body) => {
  const kinds = [['pagamento', 'Formas de pagamento'], ['cat_produto', 'Categorias de produto'], ['cat_despesa', 'Categorias de despesa'], ['responsavel', 'Responsáveis pelas saídas']];
  const data = await Promise.all(kinds.map(([k]) => GET(`/listas/${k}?todos=1`)));
  body.innerHTML = `<div class="grid grid-2">${kinds.map(([k, l], i) => `<div class="card"><h3>${l}</h3>
    ${k === 'responsavel' ? '<p class="hint">Começou com os nomes da planilha — ajuste para as três pessoas envolvidas.</p>' : ''}
    <div class="list">${data[i].map((x) => `<div class="row"><div class="main"><input value="${esc(x.name)}" data-nome="${x.id}"></div>
      <label class="check"><input type="checkbox" data-ativo="${x.id}" ${x.active ? 'checked' : ''}> ativo</label></div>`).join('')}</div>
    <div class="linha c2 form"><input placeholder="Novo item" data-novo="${k}"><button class="btn pequeno" data-add="${k}">Adicionar</button></div></div>`).join('')}</div>`;
  body.addEventListener('change', (e) => {
    const id = e.target.dataset.nome || e.target.dataset.ativo;
    if (!id) return;
    const d = e.target.dataset.nome ? { name: e.target.value } : { active: e.target.checked };
    run(null, async () => { await PUT(`/listas/item/${id}`, d); await loadRefs(true); toast('Lista atualizada.'); });
  });
  body.addEventListener('click', (e) => {
    const k = e.target.dataset.add;
    if (!k) return;
    const inp = $(`[data-novo="${k}"]`, body);
    run(e.target, async () => { await POST(`/listas/${k}`, { name: inp.value }); await loadRefs(true); toast('Item adicionado.'); CAD.listas(body); });
  });
};

CAD.config = async (body) => {
  const c = await GET('/configuracoes');
  body.innerHTML = `<form class="card form" data-f><h3>Regras</h3>
    <label>% de comissão padrão dos barbeiros<input name="pct" value="${Math.round(c.commission_pct_default * 10000) / 100}"></label>
    <label>Comissão calculada sobre<select name="base"><option value="tabela" ${c.commission_base === 'tabela' ? 'selected' : ''}>Valor dos serviços, antes do desconto (como na planilha)</option>
      <option value="apos_desconto" ${c.commission_base === 'apos_desconto' ? 'selected' : ''}>Valor após o desconto dado ao cliente</option></select></label>
    <label class="check"><input type="checkbox" name="dev" ${c.return_restock_default ? 'checked' : ''}> Em devolução online, o produto volta ao estoque (padrão; dá para mudar em cada pedido)</label>
    <p class="hint">Cancelamento online sempre devolve ao estoque. Mudanças nas regras valem para lançamentos novos — os antigos guardam a % e o valor da comissão do dia.</p>
    <div class="acoes"><button class="btn primario" type="submit">Salvar regras</button></div></form>`;
  const f = $('[data-f]', body);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    run($('button[type=submit]', f), async () => { await PUT('/configuracoes', { commission_pct_default: f.pct.value, commission_base: f.base.value, return_restock_default: f.dev.checked }); await loadRefs(true); toast('Regras salvas.'); });
  });
};

CAD.backup = async (body) => {
  const csvs = [['atendimentos', 'Atendimentos'], ['balcao', 'Vendas de balcão'], ['online', 'Vendas online'], ['produtos', 'Produtos e saldos'], ['movimentacoes', 'Movimentações de estoque'], ['contas', 'Contas a pagar'], ['saidas', 'Saídas de caixa']];
  body.innerHTML = `<div class="grid grid-2"><div class="card stack"><h3>Cópia completa (para restaurar)</h3>
      <p>Baixa todos os dados do sistema num arquivo (.json). Guarde em outro lugar (Google Drive, pen drive). Para restaurar, veja o passo a passo no manual (README).</p>
      <a class="btn primario" href="/api/exportar/backup.json">Baixar backup completo</a></div>
    <div class="card"><h3>Planilhas (CSV)</h3><p class="hint">Abrem no Excel/Google Planilhas.</p><div class="list">${csvs.map(([k, l]) => `<div class="row"><div class="main">${l}</div><a class="btn pequeno fantasma" href="/api/exportar/${k}.csv">Baixar</a></div>`).join('')}</div></div></div>`;
};

CAD.seguranca = async (body) => {
  const s = await GET('/sessao');
  body.innerHTML = `<form class="card form" data-f><h3>Senha da conta do proprietário</h3><p class="muted">Conta: ${esc(s.email)} (é a única conta do sistema)</p>
    <label>Senha atual<input type="password" name="atual" autocomplete="current-password" required></label>
    <label>Nova senha (mín. 10 caracteres, letras e números)<input type="password" name="nova" autocomplete="new-password" required></label>
    <div class="acoes"><button class="btn primario" type="submit">Trocar senha</button></div></form>`;
  const f = $('[data-f]', body);
  f.addEventListener('submit', (e) => { e.preventDefault(); run($('button[type=submit]', f), async () => { const r = await POST('/senha', { atual: f.atual.value, nova: f.nova.value }); toast(r.mensagem); setTimeout(() => { location.href = '/login'; }, 1200); }); });
};

CAD.historico = async (body) => {
  const log = await GET('/auditoria?limite=150');
  const NOMES = { atendimento: 'Atendimento', venda_balcao: 'Venda balcão', pedido_online: 'Pedido online', saida: 'Saída', conta: 'Conta', produto: 'Produto', estoque: 'Estoque', barbeiro: 'Barbeiro', servico: 'Serviço', anotacao: 'Anotação', fechamento: 'Fechamento', lista: 'Lista', configuracao: 'Regras', senha: 'Senha', caixa: 'Caixa', banco: 'Backup', sistema: 'Sistema' };
  body.innerHTML = `<div class="card"><h3>Histórico de alterações</h3><p class="hint">Tudo que é criado, editado, cancelado ou importado fica registrado com o antes e o depois.</p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Ação</th><th>O quê</th><th>#</th></tr></thead><tbody>
    ${log.map((l) => `<tr><td class="nowrap">${brDateTime(l.at)}</td><td>${esc(l.action.replace(/_/g, ' '))}</td><td>${esc(NOMES[l.entity] || l.entity)}</td><td>${l.entity_id ?? ''}</td></tr>`).join('')}</tbody></table></div></div>`;
};

// ============================== partida ==============================
$('#btn-sair').addEventListener('click', async () => { await POST('/logout').catch(() => {}); location.href = '/login'; });
$('#btn-cadastros').addEventListener('click', () => { location.hash = '#/cadastros'; });
window.addEventListener('hashchange', router);
router();
