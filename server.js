require('dotenv').config();
const express = require('express');
const basicAuth = require('express-basic-auth');
const { parse } = require('csv-parse/sync');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');

const { PORT = 3000, APP_USER = 'admin', APP_PASSWORD, DEFAULT_COUNTRY_CODE = '', MAX_PER_RUN = 300 } = process.env;
if (!APP_PASSWORD) { console.error('Définissez APP_PASSWORD dans le fichier .env'); process.exit(1); }

/* ---------- Stockage (fichier JSON) ---------- */
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const DB_FILE = path.join(DATA, 'db.json');
const STATUSES = ['yes', 'no', 'More information needed'];
let db = {
  contacts: [], logs: [],
  templates: {
    'yes': 'Bonjour, merci pour votre contribution à l’association ! 🙏',
    'no': 'Bonjour, nous serions heureux de vous compter parmi les contributeurs. Souhaitez-vous en savoir plus ?',
    'More information needed': 'Bonjour, voici les informations demandées sur la contribution des membres : ...'
  }
};
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

/* ---------- Normalisation ---------- */
const normStatus = s => {
  const v = String(s || '').trim().toLowerCase();
  if (['yes', 'oui', 'y'].includes(v)) return 'yes';
  if (['no', 'non', 'n'].includes(v)) return 'no';
  if (v.startsWith('more')) return 'More information needed';
  return null;
};
const normPhone = raw => {
  let s = String(raw || '').trim();
  const intl = s.startsWith('+') || s.startsWith('00');
  s = s.replace(/\D/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (!intl && DEFAULT_COUNTRY_CODE && !s.startsWith(DEFAULT_COUNTRY_CODE)) s = DEFAULT_COUNTRY_CODE + s.replace(/^0+/, '');
  return /^\d{8,15}$/.test(s) ? s : null;
};
function upsert({ email, status, phone }) {
  const p = normPhone(phone), st = normStatus(status);
  if (!p) return { error: 'Numéro invalide' };
  if (!st) return { error: 'Statut invalide (yes / no / More information needed)' };
  const existing = db.contacts.find(c => c.phone === p);
  if (existing) { Object.assign(existing, { email: email || existing.email, status: st }); return { updated: true }; }
  db.contacts.push({ id: crypto.randomUUID(), phone: p, email: (email || '').trim(), status: st, lastSentAt: null });
  return { added: true };
}

/* ---------- Client WhatsApp ---------- */
let waStatus = 'starting', qrImage = null, waNumber = null;
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(DATA, 'session') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }
});
client.on('qr', async qr => { waStatus = 'qr'; qrImage = await QRCode.toDataURL(qr, { width: 280 }); });
client.on('authenticated', () => { waStatus = 'authenticated'; qrImage = null; });
client.on('ready', () => { waStatus = 'ready'; qrImage = null; waNumber = client.info?.wid?.user || null; });
client.on('auth_failure', () => { waStatus = 'disconnected'; });
client.on('disconnected', () => { waStatus = 'disconnected'; waNumber = null; setTimeout(() => client.initialize().catch(() => {}), 3000); });
client.initialize().catch(e => { console.error(e); waStatus = 'disconnected'; });

/* ---------- Campagne ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const render = (t, c) => t.replace(/\{email\}/g, c.email || '').replace(/\{phone\}/g, c.phone);
let job = { running: false, total: 0, sent: 0, failed: 0, skipped: 0, current: '', stop: false };

async function runCampaign(list, message, min, max, isTest) {
  job = { running: true, total: list.length, sent: 0, failed: 0, skipped: 0, current: '', stop: false };
  for (const c of list) {
    if (job.stop) break;
    job.current = c.email || c.phone;
    const entry = { t: new Date().toISOString(), phone: c.phone, email: c.email || '', status: c.status || 'test' };
    try {
      const id = await client.getNumberId(c.phone);
      if (!id) { job.skipped++; entry.result = 'ignoré'; entry.error = 'Pas de compte WhatsApp'; }
      else {
        await client.sendMessage(id._serialized, render(message, c));
        job.sent++; entry.result = 'envoyé';
        if (!isTest) { const real = db.contacts.find(x => x.id === c.id); if (real) real.lastSentAt = entry.t; }
      }
    } catch (e) { job.failed++; entry.result = 'échec'; entry.error = String(e.message || e).slice(0, 200); }
    db.logs.push(entry); db.logs = db.logs.slice(-3000); save();
    if (c !== list[list.length - 1] && !job.stop) await sleep((min + Math.random() * (max - min)) * 1000);
  }
  job.running = false; job.current = '';
}

/* ---------- API ---------- */
const app = express();
app.use(basicAuth({ users: { [APP_USER]: APP_PASSWORD }, challenge: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const counts = Object.fromEntries(STATUSES.map(s => [s, db.contacts.filter(c => c.status === s).length]));
  res.json({ wa: { status: waStatus, qr: qrImage, number: waNumber }, counts, total: db.contacts.length, templates: db.templates, job, maxPerRun: +MAX_PER_RUN });
});
app.get('/api/contacts', (req, res) => {
  const { status, q } = req.query;
  let l = db.contacts;
  if (status) l = l.filter(c => c.status === status);
  if (q) {
    const ql = String(q).toLowerCase().trim(), qd = ql.replace(/\D/g, '');
    l = l.filter(c => c.email.toLowerCase().includes(ql) || (qd && c.phone.includes(qd)));
  }
  res.json(l);
});
app.post('/api/contacts', (req, res) => {
  const r = upsert({ email: req.body.email, status: req.body.status, phone: req.body.phone });
  if (r.error) return res.status(400).json(r);
  save(); res.json(r);
});
app.delete('/api/contacts/:id', (req, res) => { db.contacts = db.contacts.filter(c => c.id !== req.params.id); save(); res.json({ ok: true }); });
app.post('/api/contacts/delete', (req, res) => {
  const ids = new Set(Array.isArray(req.body.ids) ? req.body.ids : []);
  const before = db.contacts.length;
  db.contacts = db.contacts.filter(c => !ids.has(c.id));
  save(); res.json({ deleted: before - db.contacts.length });
});
app.delete('/api/contacts', (req, res) => { db.contacts = []; save(); res.json({ ok: true }); });

app.post('/api/import', (req, res) => {
  try {
    const rows = parse(req.body.csv, { columns: h => h.map(x => x.trim().toLowerCase()), skip_empty_lines: true, bom: true, trim: true });
    const out = { added: 0, updated: 0, invalid: [] };
    rows.forEach((r, i) => {
      const x = upsert({ email: r['email'], status: r['membership contribution'], phone: r['whatsapp number'] });
      if (x.added) out.added++; else if (x.updated) out.updated++; else out.invalid.push({ line: i + 2, email: r['email'] || '', reason: x.error });
    });
    save(); res.json(out);
  } catch (e) { res.status(400).json({ error: 'CSV illisible : ' + e.message }); }
});

app.get('/api/export.csv', (req, res) => {
  const lines = ['Email,Membership Contribution,WhatsApp Number', ...db.contacts.map(c => `${c.email},${c.status},${c.phone}`)];
  res.type('text/csv').attachment('contacts.csv').send(lines.join('\n'));
});

app.put('/api/templates', (req, res) => { db.templates = { ...db.templates, ...req.body }; save(); res.json({ ok: true }); });

app.post('/api/send', (req, res) => {
  if (waStatus !== 'ready') return res.status(400).json({ error: 'WhatsApp n’est pas connecté.' });
  if (job.running) return res.status(400).json({ error: 'Un envoi est déjà en cours.' });
  const { status, message, testNumber, skipContacted = true } = req.body;
  const min = Math.max(3, +req.body.delayMin || 8), max = Math.max(min, +req.body.delayMax || 20);
  if (!message || !message.trim()) return res.status(400).json({ error: 'Le message est vide.' });
  let list;
  if (testNumber) {
    const p = normPhone(testNumber);
    if (!p) return res.status(400).json({ error: 'Numéro de test invalide.' });
    list = [{ phone: p, email: 'test' }];
  } else {
    list = db.contacts.filter(c => c.status === status && !(skipContacted && c.lastSentAt)).slice(0, +MAX_PER_RUN);
  }
  if (!list.length) return res.status(400).json({ error: 'Aucun destinataire pour ce filtre.' });
  runCampaign(list, message, min, max, !!testNumber);
  res.json({ started: list.length });
});
app.post('/api/stop', (req, res) => { job.stop = true; res.json({ ok: true }); });
app.post('/api/reset-sent', (req, res) => { db.contacts.forEach(c => (c.lastSentAt = null)); save(); res.json({ ok: true }); });
app.get('/api/logs', (req, res) => res.json(db.logs.slice(-300).reverse()));
app.post('/api/logout', async (req, res) => {
  try { await client.logout(); } catch {}
  waStatus = 'starting'; qrImage = null;
  client.initialize().catch(() => {});
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Interface disponible sur http://localhost:${PORT}`));