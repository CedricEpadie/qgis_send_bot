const f = document.getElementById('f'), e = document.getElementById('e'), go = document.getElementById('go');
f.addEventListener('submit', async ev => {
  ev.preventDefault(); e.textContent = ''; go.disabled = true;
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.u.value.trim(), password: f.p.value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Connexion impossible.');
    location.href = '/';
  } catch (err) { e.textContent = err.message; f.p.value = ''; f.p.focus(); }
  go.disabled = false;
});
