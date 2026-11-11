'use strict';
/* ---------- Utilitaires ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICONS = {
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M20 20h.01M17 17v3"/>',
};
const ic = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

async function api(url, o = {}) {
  const r = await fetch(url, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  if (r.status === 401) { location.href = '/login'; throw new Error('Session expirée : reconnexion nécessaire.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
  return j;
}
const fmtDate = iso => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtDur = s => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min`);

/* ---------- Fenêtres contextuelles, notifications, menus ---------- */
const ui = (() => {
  const stack = [];
  let uid = 0;
  const focusables = el => $$('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])', el).filter(x => x.offsetParent !== null || x === document.activeElement);

  document.addEventListener('keydown', e => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape' && top.dismissible) { e.stopPropagation(); top.close(null); }
    if (e.key === 'Tab') {
      const f = focusables(top.el.firstElementChild);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);

  function modal({ title, body = '', actions = [], size = '', dismissible = true }) {
    const id = ++uid, opener = document.activeElement;
    const el = document.createElement('div');
    el.className = 'overlay';
    el.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="mt${id}" tabindex="-1">
      <header><h3 id="mt${id}">${esc(title)}</h3>${dismissible ? '<button class="x" data-x aria-label="Fermer">×</button>' : ''}</header>
      <div class="mbody"></div><footer></footer></div>`;
    const bodyEl = $('.mbody', el), foot = $('footer', el);
    let resolve, closed = false;
    const promise = new Promise(r => (resolve = r));
    const h = { el, body: bodyEl, promise, dismissible,
      close(v = null) {
        if (closed) return; closed = true;
        stack.splice(stack.indexOf(h), 1); el.remove();
        if (!stack.length) document.body.style.overflow = '';
        if (opener && document.contains(opener)) opener.focus();
        resolve(v);
      },
      setBody(b) { if (typeof b === 'string') bodyEl.innerHTML = b; else { bodyEl.innerHTML = ''; bodyEl.append(b); } },
      setActions(list) {
        foot.innerHTML = '';
        for (const a of list) {
          const b = document.createElement('button');
          b.className = 'btn ' + (a.kind || ''); b.textContent = a.label; if (a.disabled) b.disabled = true; if (a.id) b.id = a.id;
          b.onclick = async () => { if (a.onClick && (await a.onClick(h)) === false) return; h.close(a.value === undefined ? null : a.value); };
          foot.append(b);
        }
        foot.style.display = list.length ? '' : 'none';
      } };
    h.setBody(body); h.setActions(actions);
    el.addEventListener('mousedown', e => { if (e.target === el && dismissible) h.close(null); });
    el.addEventListener('click', e => { if (e.target.closest('[data-x]')) h.close(null); });
    document.body.append(el); document.body.style.overflow = 'hidden'; stack.push(h);
    (el.querySelector('[autofocus],input,select,textarea') || $('footer .primary,footer .danger', el) || $('.modal', el)).focus();
    return h;
  }

  const head = (tone, icon, title, text) => `<div class="mico ${tone}">${ic(icon)}</div>${text}`;

  function confirm({ title, message, html, confirmText = 'Confirmer', cancelText = 'Annuler', danger = false, requireText }) {
    const body = `<div class="mico ${danger ? 'danger' : 'warn'}">${ic('alert')}</div><p>${html || esc(message)}</p>` +
      (requireText ? `<div class="field mt"><label for="rq">Pour confirmer, tapez <b>${esc(requireText)}</b></label><input id="rq" autocomplete="off"></div>` : '');
    const m = modal({ title, body, size: 'sm', actions: [
      { label: cancelText, kind: 'ghost', value: false },
      { label: confirmText, kind: danger ? 'danger' : 'primary', value: true, id: 'cfm', disabled: !!requireText }] });
    if (requireText) $('#rq', m.el).addEventListener('input', e => { $('#cfm', m.el).disabled = e.target.value.trim() !== requireText; });
    return m.promise.then(v => v === true);
  }

  function alert({ title = 'Information', message, html, tone = 'info' }) {
    const t = tone === 'danger' ? 'danger' : tone === 'ok' ? 'ok' : 'warn';
    return modal({ title, size: 'sm', body: `<div class="mico ${t}">${ic(tone === 'ok' ? 'check' : 'alert')}</div><p>${html || esc(message)}</p>`, actions: [{ label: 'OK', kind: 'primary', value: true }] }).promise;
  }
  const error = e => alert({ title: 'Une erreur est survenue', message: (e && e.message) || String(e), tone: 'danger' });

  function fieldHtml(f) {
    const id = 'f_' + f.name, v = f.value ?? '', req = f.required ? ' required' : '';
    let input;
    if (f.type === 'textarea') input = `<textarea id="${id}" name="${f.name}" placeholder="${esc(f.placeholder || '')}"${req}>${esc(v)}</textarea>`;
    else if (f.type === 'select') input = `<select id="${id}" name="${f.name}"${req}>${(f.options || []).map(o => `<option value="${esc(o.value)}"${String(o.value) === String(v) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    else if (f.type === 'checkbox') return `<div class="field"><label class="chk"><input type="checkbox" id="${id}" name="${f.name}"${v ? ' checked' : ''}> ${esc(f.label)}</label>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
    else input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" maxlength="${f.maxlength || 200}" autocomplete="${f.autocomplete || 'off'}"${req}>`;
    return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
  }

  // Formulaire en fenêtre : renvoie les valeurs saisies, ou null si annulé.
  function form({ title, intro = '', fields, submit = 'Valider', cancel = 'Annuler', size = '', validate, danger = false }) {
    const body = `${intro}<form novalidate>${fields.map(fieldHtml).join('')}<p class="err-text" role="alert"></p><button hidden></button></form>`;
    const read = el => Object.fromEntries(fields.map(f => { const x = $(`[name="${f.name}"]`, el); return [f.name, f.type === 'checkbox' ? x.checked : x.value.trim()]; }));
    let m;
    const run = async () => {
      const v = read(m.el), err = $('.err-text', m.el);
      const miss = fields.find(f => f.required && !v[f.name]);
      const msg = miss ? `Le champ « ${miss.label} » est obligatoire.` : validate && (await validate(v));
      if (msg) { err.textContent = msg; return false; }
      return true;
    };
    m = modal({ title, body, size, actions: [
      { label: cancel, kind: 'ghost', value: null },
      { label: submit, kind: danger ? 'danger' : 'primary', onClick: async h => { if (!(await run())) return false; h.result = read(h.el); } }] });
    $('form', m.el).addEventListener('submit', e => { e.preventDefault(); $('footer .primary,footer .danger', m.el).click(); });
    const orig = m.close; m.close = v => orig(v === null && m.result ? m.result : v);
    return m.promise;
  }

  function toast(message, tone = '') {
    let box = $('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
    const t = document.createElement('div'); t.className = 'toast ' + tone; t.textContent = message; box.append(t);
    setTimeout(() => t.remove(), 4200);
  }

  let menuEl = null;
  const closeMenu = () => { if (menuEl) { menuEl.remove(); menuEl = null; } };
  function menu(anchor, items) {
    closeMenu();
    menuEl = document.createElement('div'); menuEl.className = 'menu'; menuEl.setAttribute('role', 'menu');
    menuEl.innerHTML = items.map(i => `<button role="menuitem" class="${i.danger ? 'dg' : ''}" data-act="${i.act}" data-id="${esc(i.id || '')}">${esc(i.label)}</button>`).join('');
    document.body.append(menuEl);
    const r = anchor.getBoundingClientRect();
    menuEl.style.top = window.scrollY + r.bottom + 6 + 'px';
    menuEl.style.left = Math.max(8, window.scrollX + r.right - menuEl.offsetWidth) + 'px';
    $('button', menuEl).focus();
  }
  document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  document.addEventListener('click', e => { if (menuEl && menuEl.contains(e.target)) setTimeout(closeMenu, 0); });

  return { modal, confirm, alert, error, form, toast, menu, closeMenu, open: () => stack.length };
})();
