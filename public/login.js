document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const erro = document.getElementById('erro');
  const btn = f.querySelector('button');
  erro.classList.add('hidden');
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-verdugo': '1' },
      body: JSON.stringify({ email: f.email.value, senha: f.senha.value }),
    });
    if (r.ok) { location.href = '/'; return; }
    const d = await r.json().catch(() => ({}));
    erro.textContent = d.erro || 'Não foi possível entrar.';
    erro.classList.remove('hidden');
  } catch {
    erro.textContent = 'Sem conexão com o servidor.';
    erro.classList.remove('hidden');
  } finally { btn.disabled = false; }
});
