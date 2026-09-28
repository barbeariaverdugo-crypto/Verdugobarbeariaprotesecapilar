document.getElementById('form-config').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const erro = document.getElementById('erro');
  const ok = document.getElementById('ok');
  const btn = f.querySelector('button');
  erro.classList.add('hidden');
  if (f.senha.value !== f.senha2.value) { erro.textContent = 'As duas senhas não são iguais.'; erro.classList.remove('hidden'); return; }
  btn.disabled = true;
  btn.textContent = 'Criando…';
  try {
    const r = await fetch('/api/configurar', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-verdugo': '1' },
      body: JSON.stringify({ token: f.token.value, email: f.email.value, senha: f.senha.value, importar: f.importar.checked }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      f.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
      ok.textContent = d.mensagem || 'Conta criada.';
      ok.classList.remove('hidden');
      setTimeout(() => { location.href = '/login'; }, 2500);
      return;
    }
    erro.textContent = d.erro || 'Não foi possível configurar.';
    erro.classList.remove('hidden');
  } catch {
    erro.textContent = 'Sem conexão com o servidor.';
    erro.classList.remove('hidden');
  } finally { if (!ok.textContent) { btn.disabled = false; btn.textContent = 'Criar conta'; } }
});
