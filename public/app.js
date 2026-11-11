'use strict';
/* ===== État et coquille ===== */
let S = null, TAB = 'conn', pollTimer = null, offline = false;
const TABS = [['conn', 'Connexion', 'phone'], ['contacts', 'Contacts', 'users'], ['send', 'Envoi', 'send'], ['hist', 'Historique', 'clock'], ['settings', 'Paramètres', 'settings']];
const isAdmin = () => S.me.role === 'admin';
const seg = name => S.segments.find(s => s.name === name);
const act = {};
const run = async fn => { try { await fn(); } catch (e) { if (e) ui.error(e); } };
document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (el && act[el.dataset.act]) run(() => act[el.dataset.act](el, e)); });

const SS = { ready: ['Connecté', 'ok'], qr: ['Scan requis', 'warn'], starting: ['Démarrage…', 'info'], authenticated: ['Authentification…', 'info'], error: ['Erreur', 'err'], disconnected: ['Déconnecté', 'err'], stopped: ['En veille', 'mute'], none: ['Aucun numéro', 'mute'] };
const CL = { running: ['En cours', 'info'], paused: ['En pause', 'warn'], completed: ['Terminée', 'ok'], stopped: ['Arrêtée', 'mute'] };
const badge = (lab, tone) => `<span class="badge b-${tone}">${esc(lab)}</span>`;
const fmtPhone = n => (n ? '+' + n : '');

function shell() {
  document.body.innerHTML = `<div class="app"><aside class="side">
    <div class="logo"><i>W</i>WA Broadcast</div>
    <nav class="nav" aria-label="Navigation">${TABS.map(([id, l, i]) => `<a href="#${id}" data-tab="${id}">${ic(i)}<span>${l}</span></a>`).join('')}</nav>
    <div class="sp"></div><a class="chip-st" id="chip" href="#conn" style="text-decoration:none;color:inherit"></a>
    <div class="me"><div><b id="meName"></b><span id="meRole"></span></div><button class="btn ghost icon" data-act="logout" title="Se déconnecter" aria-label="Se déconnecter">${ic('logout')}</button></div>
  </aside><main class="main"><div class="page" id="page"></div></main></div>`;
}
function paintChrome() {
  const ready = S.sessions.sessions.find(s => s.status === 'ready' && s.active);
  $('#chip').innerHTML = ready ? `${badge('Connecté', 'ok')}<span>${esc(fmtPhone(ready.number))}</span>` : badge('Non connecté', 'err');
  $('#meName').textContent = S.me.username; $('#meRole').textContent = isAdmin() ? 'Administrateur' : 'Membre';
  $$('.nav a').forEach(a => a.classList.toggle('on', a.dataset.tab === TAB));
}
act.reload = () => location.reload();
act.logout = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; };

/* ===== Connexion + fenêtre QR code ===== */
const QR = { modal: null, sid: null, html: '', done: false, auto: false };
let connKey = '';

function sessionCard(s) {
  const [lab0, tone] = SS[s.status] || [s.status, 'mute'];
  const lab = s.status === 'stopped' && !s.number ? 'À connecter' : lab0, adm = isAdmin();
  let primary = '';
  if (adm && !s.active) primary = `<button class="btn" data-act="activate" data-id="${esc(s.id)}">Utiliser</button>`;
  else if (s.active && s.status === 'qr') primary = `<button class="btn primary" data-act="show-qr" data-id="${esc(s.id)}">${ic('qr')}Afficher le QR code</button>`;
  else if (adm && ['error', 'disconnected', 'stopped'].includes(s.status)) primary = `<button class="btn" data-act="retry" data-id="${esc(s.id)}">Réessayer</button>`;
  return `<div class="card scard ${s.active ? 'act' : ''}"><div class="av">${esc((s.name || '?').slice(0, 2).toUpperCase())}</div>
    <div class="grow"><div class="t">${esc(s.name)} ${s.active ? badge('Actif', 'info').replace('b-info', 'b-info plain') : ''}</div>
    <div class="mute sm">${s.number ? esc(fmtPhone(s.number)) : 'Numéro non encore lié'}</div>${s.error ? `<div class="e">${esc(s.error)}</div>` : ''}</div>
    ${badge(lab, tone)}${primary}
    ${adm ? `<button class="btn ghost icon" data-act="session-menu" data-id="${esc(s.id)}" aria-label="Plus d’actions" aria-haspopup="menu">${ic('more')}</button>` : ''}</div>`;
}
function renderConn(force) {
  const key = JSON.stringify([S.sessions, S.me.role]);
  if (!force && key === connKey) return;
  connKey = key;
  const L = S.sessions.sessions, connected = L.some(s => s.status === 'ready'), adm = isAdmin();
  let top = '';
  if (!L.length) top = `<div class="empty"><h3>Aucun numéro enregistré</h3><p>Connectez un numéro WhatsApp pour pouvoir envoyer des messages.</p>${adm ? `<button class="btn primary" data-act="add-number">${ic('qr')}Connecter un numéro</button>` : '<p class="mt">Demandez à un administrateur de connecter un numéro.</p>'}</div>`;
  else if (!connected) top = `<div class="card row sb" style="border-color:var(--warn)"><div><b>Aucun numéro connecté</b><p class="mute sm">Scannez le QR code pour reprendre les envois.</p></div><button class="btn primary" data-act="show-qr">${ic('qr')}Scanner un QR code</button></div>`;
  $('#page').innerHTML = `<div class="ph"><div><h1>Connexion WhatsApp</h1><p>Un seul numéro est actif à la fois pour l’envoi. Basculer d’un numéro à l’autre ne demande pas de nouveau QR code.</p></div>
    ${adm && L.length ? `<button class="btn primary" data-act="add-number">${ic('plus')}Ajouter un numéro</button>` : ''}</div>${top}${L.map(sessionCard).join('')}`;
}

function openQr(sid) {
  if (QR.modal) return;
  QR.sid = sid; QR.html = ''; QR.done = false;
  QR.modal = ui.modal({ title: 'Connecter un numéro WhatsApp', size: 'sm', body: '<div class="qrbox"><div class="spin"></div></div>', actions: [{ label: 'Fermer', kind: 'ghost' }] });
  QR.modal.promise.then(() => { QR.modal = null; refresh(); });
  updateQr();
}
function updateQr() {
  const m = QR.modal; if (!m) return;
  const s = S.sessions.sessions.find(x => x.id === QR.sid), w = S.wa;
  if (!s) { m.close('gone'); return; }
  let html;
  if (s.status === 'ready') {
    html = `<div class="qrbox"><div style="text-align:center"><div class="mico ok" style="margin:0 auto 12px">${ic('check')}</div><h3>Numéro connecté</h3><p class="mute">${esc(s.name)} · ${esc(fmtPhone(s.number))}</p></div></div>`;
    if (!QR.done) { QR.done = true; setTimeout(() => { if (QR.modal === m) { m.close('ok'); ui.toast(`« ${s.name} » est connecté.`); } }, 1300); }
  } else if (s.status === 'qr' && w.id === s.id && w.qr) {
    html = `<div class="qrbox"><img src="${esc(w.qr)}" alt="QR code WhatsApp à scanner"></div>
      <ol class="how"><li>Ouvrez WhatsApp sur votre téléphone.</li><li>Allez dans <b>Réglages → Appareils connectés</b>.</li><li>Touchez <b>Connecter un appareil</b> et scannez ce code.</li></ol>`;
  } else if (['error', 'disconnected'].includes(s.status)) {
    html = `<div class="qrbox"><div style="text-align:center"><div class="mico danger" style="margin:0 auto 12px">${ic('alert')}</div><h3>La connexion a échoué</h3><p class="mute sm" style="margin:8px 0 16px">${esc(s.error || 'Une erreur est survenue.')}</p>
      <div class="row" style="justify-content:center"><button class="btn" data-act="retry" data-id="${esc(s.id)}">Réessayer</button><button class="btn" data-act="reset" data-id="${esc(s.id)}">Nouvelle session</button></div></div></div>`;
  } else html = `<div class="qrbox"><div style="text-align:center"><div class="spin"></div><p class="mute">Démarrage de WhatsApp…<br><span class="sm">Cela prend 20 à 30 secondes.</span></p></div></div>`;
  if (html !== QR.html) { QR.html = html; m.setBody(html); }
}

act['add-number'] = async () => {
  const v = await ui.form({ title: 'Ajouter un numéro', intro: '<p class="mute sm" style="margin-bottom:14px">Donnez un nom à ce numéro, puis scannez le QR code qui s’affichera.</p>', fields: [{ name: 'name', label: 'Nom du numéro', placeholder: 'Ex. Association', required: true, maxlength: 40 }], submit: 'Continuer' });
  if (!v) return;
  const s = await api('/api/sessions', { method: 'POST', body: { name: v.name } });
  await refresh(); openQr(s.id);
};
act['show-qr'] = async el => {
  const id = (el && el.dataset.id) || S.sessions.activeId;
  if (!id) return act['add-number']();
  if (id !== S.sessions.activeId) { await api(`/api/sessions/${id}/activate`, { method: 'POST' }); await refresh(); }
  openQr(id);
};
act.activate = async el => {
  await api(`/api/sessions/${el.dataset.id}/activate`, { method: 'POST' }); await refresh();
  const s = S.sessions.sessions.find(x => x.id === el.dataset.id);
  if (s && !s.number) openQr(s.id); else ui.toast('Numéro activé : WhatsApp redémarre (20 à 30 s).');
};
act.retry = async el => { await api(`/api/sessions/${el.dataset.id}/restart`, { method: 'POST' }); await refresh(); };
act.reset = async el => {
  const ok = await ui.confirm({ title: 'Nouvelle session', message: 'La session actuelle de ce numéro sera effacée et il sera déconnecté de WhatsApp. Vous devrez scanner un nouveau QR code.', confirmText: 'Effacer et rescanner', danger: true });
  if (!ok) return;
  await api(`/api/sessions/${el.dataset.id}/reset`, { method: 'POST' }); await refresh(); openQr(el.dataset.id);
};
act.rename = async el => {
  const s = S.sessions.sessions.find(x => x.id === el.dataset.id);
  const v = await ui.form({ title: 'Renommer le numéro', fields: [{ name: 'name', label: 'Nom', value: s.name, required: true, maxlength: 40 }], submit: 'Enregistrer' });
  if (v) { await api(`/api/sessions/${s.id}`, { method: 'PUT', body: { name: v.name } }); await refresh(); ui.toast('Numéro renommé.'); }
};
act.remove = async el => {
  const s = S.sessions.sessions.find(x => x.id === el.dataset.id);
  const ok = await ui.confirm({ title: 'Supprimer ce numéro ?', html: `« <b>${esc(s.name)}</b> » et sa session WhatsApp seront supprimés. Vos contacts ne sont pas touchés.`, confirmText: 'Supprimer', danger: true });
  if (ok) { await api(`/api/sessions/${s.id}`, { method: 'DELETE' }); await refresh(); ui.toast('Numéro supprimé.'); }
};
act['session-menu'] = el => ui.menu(el, [{ label: 'Renommer', act: 'rename', id: el.dataset.id }, { label: 'Nouveau QR code', act: 'reset', id: el.dataset.id }, { label: 'Supprimer', act: 'remove', id: el.dataset.id, danger: true }]);

/* ===== Contacts (communs à tous les numéros) ===== */
const C = { segment: '', q: '', page: 1, size: 25, items: [], total: 0, sel: new Set() };
let cTimer = null, cChipsKey = '';

function renderContacts() {
  $('#page').innerHTML = `<div class="ph"><div><h1>Contacts</h1><p>Une seule liste partagée par tous les numéros connectés.</p></div>
    <div class="row"><button class="btn" data-act="import">${ic('upload')}Importer un CSV</button><a class="btn" href="/api/export.csv">${ic('download')}Exporter</a><button class="btn primary" data-act="add-contact">${ic('plus')}Nouveau contact</button></div></div>
    <input type="file" id="file" accept=".csv,text/csv,text/plain" hidden>
    <div class="chips" id="cchips" role="group" aria-label="Filtrer par segment"></div>
    <div class="row mt"><div class="grow"><input id="cq" type="search" placeholder="Rechercher un nom, un e-mail ou un numéro…" aria-label="Rechercher" value="${esc(C.q)}"></div>
    <button class="btn ghost sm" data-act="del-all">${ic('trash')}Tout supprimer</button></div>
    <div class="card mt" style="padding:8px 8px 14px"><div id="cbulk"></div><div class="scroll" id="ctable"></div><div class="pager" id="cpager"></div></div>`;
  $('#cq').addEventListener('input', e => { clearTimeout(cTimer); cTimer = setTimeout(() => { C.q = e.target.value; C.page = 1; loadContacts(); }, 250); });
  $('#file').addEventListener('change', onFile);
  cChipsKey = ''; paintChips(); loadContacts();
}
function paintChips() {
  const key = JSON.stringify([S.segments, S.total, C.segment]);
  if (key === cChipsKey || TAB !== 'contacts') return; cChipsKey = key;
  $('#cchips').innerHTML = `<button class="chip ${C.segment ? '' : 'on'}" data-act="filter-seg" data-id="">Tous<em>${S.total}</em></button>` +
    S.segments.map(s => `<button class="chip ${C.segment === s.name ? 'on' : ''}" data-act="filter-seg" data-id="${esc(s.name)}">${esc(s.name)}<em>${s.count}</em></button>`).join('');
}
async function loadContacts() {
  const r = await api('/api/contacts?' + new URLSearchParams({ segment: C.segment, q: C.q, page: C.page, size: C.size }));
  C.items = r.items; C.total = r.total; C.sel.clear(); paintContacts();
}
function paintContacts() {
  if (TAB !== 'contacts') return;
  const pages = Math.max(1, Math.ceil(C.total / C.size)), all = C.items.length && C.items.every(c => C.sel.has(c.id));
  $('#ctable').innerHTML = C.items.length ? `<table class="tbl"><thead><tr><th style="width:36px"><input type="checkbox" data-act="sel-all" ${all ? 'checked' : ''} aria-label="Tout sélectionner"></th><th>Contact</th><th>Téléphone</th><th>Segment</th><th>Dernier envoi</th><th></th></tr></thead><tbody>${C.items.map(c =>
    `<tr><td><input type="checkbox" data-act="sel" data-id="${esc(c.id)}" ${C.sel.has(c.id) ? 'checked' : ''} aria-label="Sélectionner ${esc(c.name || c.phone)}"></td>
    <td><b>${esc(c.name || '—')}</b><div class="mute sm">${esc(c.email)}</div></td><td>${esc(fmtPhone(c.phone))}</td><td><span class="badge plain">${esc(c.segment)}</span></td>
    <td class="mute sm">${c.lastSentAt ? fmtDate(c.lastSentAt) : 'Jamais'}</td><td style="text-align:right"><button class="btn ghost sm" data-act="edit-contact" data-id="${esc(c.id)}">Modifier</button></td></tr>`).join('')}</tbody></table>`
    : `<div class="empty" style="margin:10px"><h3>${C.q || C.segment ? 'Aucun résultat' : 'Aucun contact'}</h3><p>${C.q || C.segment ? 'Essayez un autre filtre.' : 'Importez un fichier CSV ou ajoutez un premier contact.'}</p></div>`;
  $('#cpager').innerHTML = `<span>${C.total} contact(s)</span><span class="row"><button class="btn sm" data-act="page" data-id="-1" ${C.page <= 1 ? 'disabled' : ''}>Précédent</button> Page ${C.page} / ${pages} <button class="btn sm" data-act="page" data-id="1" ${C.page >= pages ? 'disabled' : ''}>Suivant</button></span>`;
  paintBulk();
}
function paintBulk() {
  $('#cbulk').innerHTML = C.sel.size ? `<div class="bulk"><b>${C.sel.size} sélectionné(s)</b><button class="btn danger sm" data-act="del-sel">${ic('trash')}Supprimer</button></div>` : '';
}
act['filter-seg'] = el => { C.segment = el.dataset.id; C.page = 1; cChipsKey = ''; paintChips(); return loadContacts(); };
act.page = el => { C.page += +el.dataset.id; return loadContacts(); };
act.sel = el => { el.checked ? C.sel.add(el.dataset.id) : C.sel.delete(el.dataset.id); paintBulk(); };
act['sel-all'] = el => { C.items.forEach(c => (el.checked ? C.sel.add(c.id) : C.sel.delete(c.id))); paintContacts(); };
act['del-sel'] = async () => {
  const n = C.sel.size, ok = await ui.confirm({ title: 'Supprimer les contacts ?', message: `${n} contact(s) seront supprimés définitivement.`, confirmText: 'Supprimer', danger: true });
  if (!ok) return;
  await api('/api/contacts/delete', { method: 'POST', body: { ids: [...C.sel] } }); ui.toast(`${n} contact(s) supprimé(s).`); await refresh(); await loadContacts();
};
act['del-all'] = async () => {
  if (!S.total) return ui.alert({ title: 'Liste vide', message: 'Il n’y a aucun contact à supprimer.' });
  const ok = await ui.confirm({ title: 'Supprimer TOUS les contacts ?', html: `Les <b>${S.total}</b> contacts de l’organisation seront supprimés définitivement.`, confirmText: 'Tout supprimer', danger: true, requireText: 'SUPPRIMER' });
  if (!ok) return;
  await api('/api/contacts', { method: 'DELETE' }); ui.toast('Tous les contacts ont été supprimés.'); await refresh(); await loadContacts();
};

const contactFields = (c = {}) => [
  { name: 'phone', label: 'Téléphone WhatsApp', value: c.phone ? '+' + c.phone : '', placeholder: '+237 6 99 99 99 99', required: true, type: 'tel', hint: 'Avec l’indicatif du pays.' },
  { name: 'name', label: 'Nom', value: c.name || '', placeholder: 'Marie Kamga', maxlength: 80 },
  { name: 'email', label: 'E-mail', value: c.email || '', type: 'email' },
  { name: 'segment', label: 'Segment', type: 'select', value: c.segment || (C.segment || S.segments[0]?.name), options: S.segments.map(s => ({ value: s.name, label: s.name })), required: true }];
async function ensureSegments() {
  if (S.segments.length) return true;
  await ui.alert({ title: 'Créez d’abord un segment', message: 'Un segment regroupe vos contacts (par exemple « Donateurs »). Créez-en un dans Paramètres, ou importez un fichier CSV : les segments seront créés automatiquement.' });
  location.hash = '#settings'; return false;
}
act['add-contact'] = async () => {
  if (!(await ensureSegments())) return;
  const v = await ui.form({ title: 'Nouveau contact', fields: contactFields(), submit: 'Ajouter', validate: v => (/^[+\d\s().-]{8,}$/.test(v.phone) ? '' : 'Numéro de téléphone invalide.') });
  if (!v) return;
  const r = await api('/api/contacts', { method: 'POST', body: v });
  ui.toast(r.updated ? 'Ce numéro existait déjà : contact mis à jour.' : 'Contact ajouté.'); await refresh(); await loadContacts();
};
act['edit-contact'] = async el => {
  const c = C.items.find(x => x.id === el.dataset.id);
  const v = await ui.form({ title: 'Modifier le contact', fields: contactFields(c), submit: 'Enregistrer' });
  if (!v) return;
  await api('/api/contacts/' + c.id, { method: 'PUT', body: v }); ui.toast('Contact mis à jour.'); await refresh(); await loadContacts();
};

/* ---- Import CSV avec correspondance des colonnes ---- */
act.import = () => { $('#file').value = ''; $('#file').click(); };
async function onFile(e) {
  const f = e.target.files[0]; if (!f) return;
  await run(async () => {
    const csv = await f.text(), p = await api('/api/import/preview', { method: 'POST', body: { csv } });
    const cols = (none) => [...(none ? [{ value: '', label: '— aucune —' }] : []), ...p.headers.map((h, i) => ({ value: i, label: h || `Colonne ${i + 1}` }))];
    const m = p.mapping, val = k => (m[k] === null ? '' : m[k]);
    const intro = `<p class="mute sm">${p.total} ligne(s) détectée(s) dans <b>${esc(f.name)}</b>. Vérifiez la correspondance des colonnes.</p>
      <div class="scroll mt" style="max-height:170px"><table class="tbl"><thead><tr>${p.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${p.sample.map(r => `<tr>${p.headers.map((_, i) => `<td class="sm">${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="mt"></div>`;
    const v = await ui.form({ title: 'Importer des contacts', size: 'lg', intro, submit: `Importer ${p.total} ligne(s)`, fields: [
      { name: 'phone', label: 'Colonne du téléphone', type: 'select', options: cols(false), value: val('phone'), required: true },
      { name: 'name', label: 'Colonne du nom', type: 'select', options: cols(true), value: val('name') },
      { name: 'email', label: 'Colonne de l’e-mail', type: 'select', options: cols(true), value: val('email') },
      { name: 'segment', label: 'Colonne du segment', type: 'select', options: cols(true), value: val('segment'), hint: 'Les segments inconnus sont créés automatiquement.' },
      { name: 'def', label: 'Segment par défaut (si aucune colonne)', type: 'select', options: [{ value: '', label: '— choisir —' }, ...S.segments.map(s => ({ value: s.name, label: s.name }))] },
      { name: 'newSeg', label: 'ou nouveau segment', placeholder: 'Ex. Donateurs 2026', maxlength: 60 }],
      validate: x => (x.segment === '' && !x.def && !x.newSeg ? 'Choisissez une colonne de segment, ou un segment par défaut.' : '') });
    if (!v) return;
    const idx = x => (x === '' ? null : +x);
    const r = await api('/api/import', { method: 'POST', body: { csv, mapping: { phone: idx(v.phone), name: idx(v.name), email: idx(v.email), segment: idx(v.segment) }, defaultSegment: v.newSeg || v.def } });
    await refresh(); await loadContacts();
    ui.modal({ title: 'Import terminé', body: `<div class="kv"><div><b>${r.added}</b><span>ajoutés</span></div><div><b>${r.updated}</b><span>mis à jour</span></div><div><b>${r.invalidCount}</b><span>ignorés</span></div></div>
      ${r.createdSegments.length ? `<p class="sm">Segments créés : ${r.createdSegments.map(esc).join(', ')}.</p>` : ''}
      ${r.invalid.length ? `<p class="mt sm mute">Lignes ignorées :</p><div class="scroll" style="max-height:180px"><table class="tbl">${r.invalid.slice(0, 20).map(x => `<tr><td class="sm">Ligne ${x.line}</td><td class="sm">${esc(x.label)}</td><td class="sm" style="color:var(--err)">${esc(x.reason)}</td></tr>`).join('')}</table></div>` : ''}`,
      actions: [{ label: 'Terminer', kind: 'primary' }] });
  });
}

/* ===== Envoi : assistant en 3 étapes ===== */
const W = { step: 1, segment: '', skip: true, message: '', tplFor: '', dmin: 8, dmax: 20, preview: null };
let sendKey = '', sendDirty = false;
const campaignOpen = () => S.campaign && ['running', 'paused'].includes(S.campaign.status);
const activeSession = () => S.sessions.sessions.find(s => s.active);
const SAMPLE = { name: 'Marie', email: 'marie@exemple.org', phone: '237600000000' };
const renderMsg = (t, c) => String(t).replace(/\{name\}/g, c.name || '').replace(/\{email\}/g, c.email || '').replace(/\{phone\}/g, c.phone || '');
const estimate = () => (W.preview ? W.preview.willSend * ((W.dmin + W.dmax) / 2) : 0);

function renderSend() {
  sendKey = JSON.stringify([campaignOpen(), S.segments.map(s => [s.name, s.count])]); sendDirty = false;
  $('#page').innerHTML = `<div class="ph"><div><h1>Envoi de messages</h1><p>Choisissez un segment, rédigez le message, vérifiez, puis lancez. Les envois sont espacés pour limiter les risques de blocage.</p></div></div>
    <div id="cpanel"></div>${campaignOpen() ? `<div class="card"><b>Une campagne est déjà ${S.campaign.status === 'paused' ? 'en pause' : 'en cours'}.</b><p class="mute sm">Reprenez-la ou arrêtez-la pour en préparer une nouvelle.</p></div>` : '<div id="wiz"></div>'}`;
  paintCampaign(); if (!campaignOpen()) paintWizard();
}
function paintCampaign() {
  const c = S.campaign, box = $('#cpanel'); if (!box) return;
  if (!c) { box.innerHTML = ''; return; }
  const done = c.sent + c.failed + c.skipped, open = ['running', 'paused'].includes(c.status), [lab, tone] = CL[c.status] || [c.status, 'mute'];
  box.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row sb"><div><h2>${c.isTest ? 'Message de test' : 'Campagne'} ${c.groupStatus ? '· ' + esc(c.groupStatus) : ''}</h2>
    <p class="mute sm">${esc(c.sessionLabel || '')}${c.createdBy ? ' · lancée par ' + esc(c.createdBy) : ''}</p></div>${badge(c.pausing ? 'Pause en cours…' : lab, c.pausing ? 'warn' : tone)}</div>
    <div class="bar mt" role="progressbar" aria-valuemin="0" aria-valuemax="${c.total}" aria-valuenow="${done + c.cancelled}"><i style="width:${c.total ? ((done + c.cancelled) / c.total) * 100 : 0}%"></i></div>
    <div class="kv"><div><b>${c.sent}</b><span>envoyés</span></div><div><b>${c.skipped}</b><span>ignorés</span></div><div><b>${c.failed}</b><span>échecs</span></div><div><b>${c.pending}</b><span>restants</span></div></div>
    ${c.current ? `<p class="sm mute">En cours : ${esc(c.current)}</p>` : ''}${c.note ? `<p class="sm" style="color:var(--warn)">${esc(c.note)}</p>` : ''}
    ${open ? `<div class="row mt">${c.status === 'running' ? `<button class="btn" data-act="camp" data-id="pause" ${c.pausing ? 'disabled' : ''}>Pause</button>` : `<button class="btn primary" data-act="camp" data-id="resume">Reprendre</button>`}<button class="btn danger" data-act="camp" data-id="stop">Arrêter</button></div>` : ''}</div>`;
}
act.camp = async el => {
  const a = el.dataset.id;
  if (a === 'stop' && !(await ui.confirm({ title: 'Arrêter la campagne ?', message: 'Les messages restants ne seront pas envoyés. Cette action est définitive.', confirmText: 'Arrêter', danger: true }))) return;
  await api('/api/campaign/' + a, { method: 'POST' });
  ui.toast({ pause: 'Pause demandée : fin du message en cours…', resume: 'Envoi repris avec le numéro actif.', stop: 'Campagne arrêtée.' }[a]); await refresh();
};

const stepper = n => `<ol class="steps">${['Destinataires', 'Message', 'Lancement'].map((l, i) => `<li class="${i + 1 === n ? 'on' : i + 1 < n ? 'done' : ''}"><b>${i + 1 < n ? '✓' : i + 1}</b>${l}</li>`).join('')}</ol>`;
function paintWizard() {
  const box = $('#wiz'); if (!box) return;
  if (W.step === 1) {
    box.innerHTML = stepper(1) + `<div class="card"><h2>Qui doit recevoir le message ?</h2>${S.segments.length ? `<div class="pick mt">${S.segments.map(s => `<button class="opt ${W.segment === s.name ? 'on' : ''}" data-act="pick-seg" data-id="${esc(s.name)}"><b>${esc(s.name)}</b><span>${s.count} contact(s)</span></button>`).join('')}</div>`
      : '<div class="empty mt"><h3>Aucun segment</h3><p>Importez des contacts pour commencer.</p><button class="btn primary" data-act="goto-contacts">Aller aux contacts</button></div>'}
      <label class="chk mt"><input type="checkbox" data-act="toggle-skip" ${W.skip ? 'checked' : ''}> Ignorer les contacts déjà contactés</label>
      <p class="hint mt" id="pv" aria-live="polite"></p>
      <div class="row sb mt"><button class="btn ghost sm" data-act="reset-sent">Réinitialiser « déjà contacté »</button><button class="btn primary" id="next1" data-act="step" data-id="2" disabled>Continuer</button></div></div>`;
    pvText();
  } else if (W.step === 2) {
    const sample = W.preview?.sample || SAMPLE;
    box.innerHTML = stepper(2) + `<div class="card"><h2>Rédigez votre message</h2><div class="row mt" style="align-items:flex-start"><div class="grow" style="min-width:270px">
      <div class="field"><label for="msg">Message</label><textarea id="msg" maxlength="4000">${esc(W.message)}</textarea>
      <div class="vars">${['{name}', '{email}', '{phone}'].map(v => `<button class="chip" type="button" data-act="ins-var" data-id="${v}">${v}</button>`).join('')}</div><span class="hint">Les variables sont remplacées pour chaque contact.</span></div></div>
      <div class="grow" style="min-width:260px"><label class="sm" style="font-weight:600">Aperçu</label><div class="phone mt"><div class="bubble" id="bubble"></div></div><p class="hint mt">Exemple avec : ${esc(sample.name || sample.email || fmtPhone(sample.phone))}</p></div></div>
      <div class="row sb mt"><div class="row"><button class="btn ghost sm" data-act="save-tpl">Enregistrer comme modèle du segment</button><button class="btn ghost sm" data-act="test-send">Envoyer un test</button></div>
      <div class="row"><button class="btn ghost" data-act="step" data-id="1">Retour</button><button class="btn primary" data-act="step" data-id="3">Continuer</button></div></div></div>`;
    const ta = $('#msg'); const upd = () => { W.message = ta.value; $('#bubble').textContent = renderMsg(W.message, sample) || '…'; }; ta.addEventListener('input', upd); upd();
  } else {
    const a = activeSession(), ready = a && a.status === 'ready', p = W.preview;
    box.innerHTML = stepper(3) + `<div class="card"><h2>Vérifiez avant de lancer</h2>
      <div class="kv"><div><b>${p ? p.willSend : 0}</b><span>destinataires</span></div><div><b id="est">${fmtDur(estimate())}</b><span>durée estimée</span></div><div><b>${esc(W.segment)}</b><span>segment</span></div></div>
      ${p && p.eligible > p.willSend ? `<p class="sm" style="color:var(--warn)">Limite de ${p.maxPerRun} messages par campagne : ${p.eligible - p.willSend} contact(s) resteront pour la suivante.</p>` : ''}
      <p class="sm mt">Envoi depuis : <b>${ready ? esc(a.name + ' (' + fmtPhone(a.number) + ')') : 'aucun numéro connecté'}</b></p>${ready ? '' : `<p class="sm" style="color:var(--err)">Connectez un numéro dans l’onglet Connexion pour pouvoir lancer l’envoi.</p>`}
      <div class="phone mt"><div class="bubble">${esc(renderMsg(W.message, p?.sample || SAMPLE))}</div></div>
      <div class="row mt"><div class="field" style="width:150px;margin:0"><label for="dmin">Pause min. (s)</label><input id="dmin" type="number" min="3" max="600" value="${W.dmin}"></div>
      <div class="field" style="width:150px;margin:0"><label for="dmax">Pause max. (s)</label><input id="dmax" type="number" min="3" max="900" value="${W.dmax}"></div></div><p class="hint">Une pause aléatoire est observée entre deux messages.</p>
      <div class="row sb mt"><button class="btn ghost" data-act="step" data-id="2">Retour</button><button class="btn primary" data-act="launch" ${ready && p && p.willSend ? '' : 'disabled'}>${ic('send')}Lancer l’envoi</button></div></div>`;
    const sync = () => { W.dmin = Math.max(3, +$('#dmin').value || 3); W.dmax = Math.max(W.dmin, +$('#dmax').value || W.dmin); $('#est').textContent = fmtDur(estimate()); };
    $('#dmin').addEventListener('input', sync); $('#dmax').addEventListener('input', sync);
  }
}
function pvText() {
  const p = W.preview, el = $('#pv'), nx = $('#next1'); if (!el) return;
  if (!W.segment) { el.textContent = 'Sélectionnez un segment.'; nx.disabled = true; return; }
  if (!p) { el.textContent = 'Calcul…'; nx.disabled = true; return; }
  const skipped = p.total - p.eligible;
  el.textContent = `${p.eligible} destinataire(s) éligible(s) sur ${p.total}${skipped ? ` (${skipped} déjà contacté(s) ignoré(s))` : ''}.`;
  nx.disabled = p.willSend === 0;
}
async function loadPreview() {
  if (!W.segment) return; W.preview = null; pvText();
  const seg0 = W.segment;
  const p = await api('/api/send/preview', { method: 'POST', body: { segment: seg0, skipContacted: W.skip } });
  if (W.segment === seg0) { W.preview = p; pvText(); }
}
act['pick-seg'] = async el => {
  const prev = seg(W.tplFor), s = seg(el.dataset.id);
  W.segment = s.name; if (!W.message || (prev && W.message === prev.template)) W.message = s.template; W.tplFor = s.name;
  $$('.opt').forEach(o => o.classList.toggle('on', o.dataset.id === s.name)); await loadPreview();
};
act['toggle-skip'] = el => { W.skip = el.checked; return loadPreview(); };
act['goto-contacts'] = () => { location.hash = '#contacts'; };
act['reset-sent'] = async () => {
  const ok = await ui.confirm({ title: 'Réinitialiser « déjà contacté » ?', message: 'Tous les contacts redeviendront éligibles aux prochains envois.', confirmText: 'Réinitialiser' });
  if (!ok) return; await api('/api/reset-sent', { method: 'POST' }); ui.toast('Statut « déjà contacté » réinitialisé.'); await loadPreview();
};
act.step = async el => {
  const n = +el.dataset.id;
  if (n === 3 && !W.message.trim()) return ui.alert({ title: 'Message vide', message: 'Rédigez un message avant de continuer.' });
  if (n === 3) await loadPreview();
  W.step = n; paintWizard();
};
act['ins-var'] = el => {
  const ta = $('#msg'), v = el.dataset.id, a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  ta.setRangeText(v, a, b, 'end'); ta.focus(); ta.dispatchEvent(new Event('input'));
};
act['save-tpl'] = async () => {
  if (!W.message.trim()) return ui.alert({ title: 'Message vide', message: 'Rien à enregistrer.' });
  await api('/api/segments/' + encodeURIComponent(W.segment), { method: 'PUT', body: { template: W.message } }); await refresh(); ui.toast(`Modèle du segment « ${W.segment} » enregistré.`);
};
act['test-send'] = async () => {
  if (!W.message.trim()) return ui.alert({ title: 'Message vide', message: 'Rédigez un message avant d’envoyer un test.' });
  const v = await ui.form({ title: 'Envoyer un test', intro: '<p class="mute sm" style="margin-bottom:14px">Le message sera envoyé à ce numéro, avec « Test » comme nom.</p>', fields: [{ name: 'phone', label: 'Numéro de test', placeholder: '+237 6 99 99 99 99', type: 'tel', required: true }], submit: 'Envoyer le test' });
  if (!v) return;
  await api('/api/send', { method: 'POST', body: { testNumber: v.phone, message: W.message, delayMin: 3, delayMax: 3 } }); ui.toast('Test en cours d’envoi.'); await refresh();
};
act.launch = async () => {
  const p = W.preview, a = activeSession();
  const ok = await ui.confirm({ title: 'Lancer l’envoi ?', html: `<b>${p.willSend} message(s)</b> seront envoyés depuis <b>${esc(a.name)}</b>, avec une pause de ${W.dmin} à ${W.dmax} s entre deux messages (environ <b>${fmtDur(estimate())}</b>).<br><br>Vous pourrez mettre en pause ou arrêter à tout moment.`, confirmText: 'Lancer l’envoi' });
  if (!ok) return;
  await api('/api/send', { method: 'POST', body: { segment: W.segment, message: W.message, skipContacted: W.skip, delayMin: W.dmin, delayMax: W.dmax } });
  ui.toast('Campagne lancée.'); W.step = 1; W.preview = null; await refresh();
};

/* ===== Historique ===== */
async function renderHist() {
  $('#page').innerHTML = '<div class="ph"><div><h1>Historique</h1><p>Campagnes récentes et derniers envois.</p></div></div><div id="histbox"><div class="spin"></div></div>';
  const [cs, logs] = await Promise.all([api('/api/campaigns'), api('/api/logs')]);
  if (TAB !== 'hist') return;
  const RES = { 'envoyé': 'ok', 'ignoré': 'warn', 'échec': 'err' };
  $('#histbox').innerHTML = `<div class="card scroll"><h2 style="margin-bottom:10px">Campagnes</h2>${cs.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Segment</th><th>Numéro</th><th>Par</th><th>Statut</th><th>Résultat</th></tr></thead><tbody>${cs.map(c => { const [l, t] = CL[c.status] || [c.status, 'mute']; return `<tr><td>${fmtDate(c.created_at)}</td><td>${c.is_test ? 'Test' : esc(c.group_status || '')}</td><td class="sm">${esc(c.session_label || '—')}</td><td class="sm">${esc(c.created_by || '—')}</td><td>${badge(l, t)}</td><td class="sm">${c.sent} envoyés · ${c.skipped} ignorés · ${c.failed} échecs${c.pending ? ' · ' + c.pending + ' restants' : ''}${c.cancelled ? ' · ' + c.cancelled + ' annulés' : ''}</td></tr>`; }).join('')}</tbody></table>` : '<p class="mute">Aucune campagne pour le moment.</p>'}</div>
    <div class="card scroll"><h2 style="margin-bottom:10px">Derniers envois</h2>${logs.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Contact</th><th>Segment</th><th>Résultat</th></tr></thead><tbody>${logs.map(x => `<tr><td>${fmtDate(x.t)}</td><td>${esc(x.email || '')} ${esc(fmtPhone(x.phone))}</td><td class="sm">${esc(x.status || '')}</td><td>${badge(x.result, RES[x.result] || 'mute')}${x.error ? ` <span class="sm mute">${esc(x.error)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="mute">Aucun envoi pour le moment.</p>'}</div>`;
}

/* ===== Paramètres : segments, utilisateurs, compte ===== */
let USERS = [];
async function renderSettings() {
  if (isAdmin()) USERS = await api('/api/users');
  if (TAB !== 'settings') return;
  $('#page').innerHTML = `<div class="ph"><div><h1>Paramètres</h1><p>Segments de contacts, utilisateurs et sécurité du compte.</p></div></div>
  <div class="card"><div class="row sb"><div><h2>Segments</h2><p class="mute sm">Regroupez vos contacts ; chaque segment peut avoir son modèle de message.</p></div><button class="btn primary" data-act="new-segment">${ic('plus')}Nouveau segment</button></div>
    ${S.segments.length ? `<div class="scroll mt"><table class="tbl"><thead><tr><th>Segment</th><th>Contacts</th><th>Modèle</th><th></th></tr></thead><tbody>${S.segments.map(s => `<tr><td><b>${esc(s.name)}</b></td><td>${s.count}</td><td class="mute sm">${esc((s.template || '—').slice(0, 70))}</td><td style="text-align:right"><button class="btn ghost sm" data-act="rename-segment" data-id="${esc(s.name)}">Renommer</button> <button class="btn ghost sm" data-act="del-segment" data-id="${esc(s.name)}">Supprimer</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="mute mt">Aucun segment.</p>'}</div>
  ${isAdmin() ? `<div class="card"><div class="row sb"><div><h2>Utilisateurs</h2><p class="mute sm">Les administrateurs gèrent les numéros et les utilisateurs ; les membres gèrent contacts et envois.</p></div><button class="btn primary" data-act="new-user">${ic('plus')}Ajouter</button></div>
    <div class="scroll mt"><table class="tbl"><thead><tr><th>Identifiant</th><th>Rôle</th><th>Créé le</th><th></th></tr></thead><tbody>${USERS.map(u => `<tr><td><b>${esc(u.username)}</b>${u.username === S.me.username ? ' <span class="mute sm">(vous)</span>' : ''}</td><td>${badge(u.role === 'admin' ? 'Administrateur' : 'Membre', u.role === 'admin' ? 'info' : 'mute')}</td><td class="mute sm">${fmtDate(u.createdAt)}</td><td style="text-align:right"><button class="btn ghost sm" data-act="user-menu" data-id="${esc(u.id)}" aria-haspopup="menu">Actions</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
  <div class="card"><div class="row sb"><div><h2>Mon compte</h2><p class="mute sm">Connecté en tant que <b>${esc(S.me.username)}</b>.</p></div><button class="btn" data-act="my-password">Changer mon mot de passe</button></div></div>`;
}
act['new-segment'] = async () => {
  const v = await ui.form({ title: 'Nouveau segment', fields: [{ name: 'name', label: 'Nom du segment', placeholder: 'Ex. Donateurs', required: true, maxlength: 60 }], submit: 'Créer' });
  if (v) { await api('/api/segments', { method: 'POST', body: { name: v.name } }); await refresh(); await renderSettings(); ui.toast('Segment créé.'); }
};
act['rename-segment'] = async el => {
  const v = await ui.form({ title: 'Renommer le segment', fields: [{ name: 'name', label: 'Nouveau nom', value: el.dataset.id, required: true, maxlength: 60 }], submit: 'Enregistrer' });
  if (v) { await api('/api/segments/' + encodeURIComponent(el.dataset.id), { method: 'PUT', body: { name: v.name } }); await refresh(); await renderSettings(); ui.toast('Segment renommé.'); }
};
act['del-segment'] = async el => {
  const s = seg(el.dataset.id), others = S.segments.filter(x => x.name !== s.name);
  let url = '/api/segments/' + encodeURIComponent(s.name);
  if (s.count) {
    if (!others.length) return ui.alert({ title: 'Suppression impossible', message: 'Ce segment contient des contacts et c’est le seul : créez un autre segment pour les y déplacer.' });
    const v = await ui.form({ title: 'Supprimer le segment', intro: `<p style="margin-bottom:14px">« <b>${esc(s.name)}</b> » contient <b>${s.count}</b> contact(s). Choisissez où les déplacer.</p>`, fields: [{ name: 'moveTo', label: 'Déplacer les contacts vers', type: 'select', options: others.map(o => ({ value: o.name, label: o.name })), required: true }], submit: 'Supprimer le segment', danger: true });
    if (!v) return; url += '?moveTo=' + encodeURIComponent(v.moveTo);
  } else if (!(await ui.confirm({ title: 'Supprimer le segment ?', html: `« <b>${esc(s.name)}</b> » est vide et sera supprimé.`, confirmText: 'Supprimer', danger: true }))) return;
  await api(url, { method: 'DELETE' }); await refresh(); await renderSettings(); ui.toast('Segment supprimé.');
};
const pwFields = (cur) => [...(cur ? [{ name: 'current', label: 'Mot de passe actuel', type: 'password', required: true, autocomplete: 'current-password' }] : []),
  { name: 'next', label: 'Nouveau mot de passe', type: 'password', required: true, autocomplete: 'new-password', hint: '8 caractères minimum.' },
  { name: 'again', label: 'Confirmer le mot de passe', type: 'password', required: true, autocomplete: 'new-password' }];
const pwCheck = v => (v.next.length < 8 ? 'Le mot de passe doit contenir au moins 8 caractères.' : v.next !== v.again ? 'Les deux mots de passe ne correspondent pas.' : '');
act['my-password'] = async () => {
  const v = await ui.form({ title: 'Changer mon mot de passe', fields: pwFields(true), submit: 'Enregistrer', validate: pwCheck });
  if (v) { await api('/api/auth/password', { method: 'POST', body: { current: v.current, next: v.next } }); ui.toast('Mot de passe modifié. Vos autres appareils ont été déconnectés.'); }
};
act['new-user'] = async () => {
  const v = await ui.form({ title: 'Ajouter un utilisateur', fields: [{ name: 'username', label: 'Identifiant', required: true, maxlength: 40, autocomplete: 'off' }, { name: 'role', label: 'Rôle', type: 'select', value: 'member', options: [{ value: 'member', label: 'Membre : contacts et envois' }, { value: 'admin', label: 'Administrateur : tout gérer' }] }, ...pwFields(false)], submit: 'Créer le compte', validate: pwCheck });
  if (v) { await api('/api/users', { method: 'POST', body: { username: v.username, password: v.next, role: v.role } }); ui.toast('Utilisateur créé.'); await renderSettings(); }
};
act['user-menu'] = el => {
  const u = USERS.find(x => x.id === el.dataset.id);
  ui.menu(el, [{ label: u.role === 'admin' ? 'Passer en membre' : 'Passer administrateur', act: 'user-role', id: u.id }, { label: 'Réinitialiser le mot de passe', act: 'user-pw', id: u.id }, ...(u.username === S.me.username ? [] : [{ label: 'Supprimer', act: 'user-del', id: u.id, danger: true }])]);
};
act['user-role'] = async el => { const u = USERS.find(x => x.id === el.dataset.id); await api('/api/users/' + u.id, { method: 'PUT', body: { role: u.role === 'admin' ? 'member' : 'admin' } }); ui.toast('Rôle modifié.'); await renderSettings(); };
act['user-pw'] = async el => {
  const u = USERS.find(x => x.id === el.dataset.id);
  const v = await ui.form({ title: `Nouveau mot de passe pour « ${u.username} »`, fields: pwFields(false), submit: 'Enregistrer', validate: pwCheck });
  if (v) { await api('/api/users/' + u.id, { method: 'PUT', body: { password: v.next } }); ui.toast('Mot de passe modifié ; cet utilisateur est déconnecté.'); }
};
act['user-del'] = async el => {
  const u = USERS.find(x => x.id === el.dataset.id);
  if (await ui.confirm({ title: 'Supprimer cet utilisateur ?', html: `Le compte « <b>${esc(u.username)}</b> » sera supprimé et déconnecté.`, confirmText: 'Supprimer', danger: true })) { await api('/api/users/' + u.id, { method: 'DELETE' }); ui.toast('Utilisateur supprimé.'); await renderSettings(); }
};

/* ===== Routage, rafraîchissement, démarrage ===== */
function route() {
  TAB = TABS.some(t => t[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'conn';
  ui.closeMenu(); QR.auto = false; connKey = ''; paintChrome();
  run(async () => {
    if (TAB === 'conn') { renderConn(true); maybeAutoQr(); }
    else if (TAB === 'contacts') renderContacts();
    else if (TAB === 'send') { renderSend(); }
    else if (TAB === 'hist') await renderHist();
    else await renderSettings();
  });
}
function maybeAutoQr() {   // le QR code ne s'ouvre automatiquement que si aucun numéro n'est connecté
  const connected = S.sessions.sessions.some(s => s.status === 'ready');
  if (connected) { QR.auto = false; return; }
  if (TAB === 'conn' && !QR.auto && !QR.modal && !ui.open() && S.wa.status === 'qr' && S.wa.id) { QR.auto = true; openQr(S.wa.id); }
}
function onState() {
  paintChrome(); updateQr();
  if (TAB === 'conn') { renderConn(); maybeAutoQr(); }
  else if (TAB === 'contacts') paintChips();
  else if (TAB === 'send') {
    paintCampaign();
    const key = JSON.stringify([campaignOpen(), S.segments.map(s => [s.name, s.count])]);
    if (key !== sendKey) { if (document.activeElement && document.activeElement.closest('#wiz') && /TEXTAREA|INPUT/.test(document.activeElement.tagName)) sendDirty = true; else renderSend(); }
  }
}
async function refresh() {
  try { S = await api('/api/state'); if (offline) { offline = false; ui.toast('Connexion au serveur rétablie.'); } onState(); }
  catch (e) { if (!offline && S) { offline = true; ui.toast('Connexion au serveur perdue. Nouvelle tentative…', 'err'); } }
}
function loop() { clearTimeout(pollTimer); pollTimer = setTimeout(async () => { await refresh(); loop(); }, QR.modal ? 1000 : 2000); }
(async function boot() {
  try { S = await api('/api/state'); } catch (e) { document.body.innerHTML = `<div class="login"><div class="card"><h2>Impossible de joindre le serveur</h2><p class="mute mt">${esc(e.message)}</p><button class="btn primary mt" data-act="reload">Réessayer</button></div></div>`; return; }
  shell(); window.addEventListener('hashchange', route); route(); loop();
})();
document.addEventListener('focusout', () => { if (sendDirty && TAB === 'send') setTimeout(() => { if (!(document.activeElement && document.activeElement.closest('#wiz'))) renderSend(); }, 0); });
