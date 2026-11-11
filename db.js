// Stockage SQLite : contacts partagés par tous les numéros, modèles, campagnes persistantes, historique.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./config');
const { normPhone, normStatus } = require('./normalize');
const { HttpError } = require('./http');

const db = new Database(path.join(DATA, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS contacts(
  id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, last_sent_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE TABLE IF NOT EXISTS templates(status TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns(
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0, group_status TEXT, message TEXT NOT NULL,
  delay_min INTEGER NOT NULL, delay_max INTEGER NOT NULL, session_id TEXT, session_label TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE TABLE IF NOT EXISTS campaign_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id TEXT, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', status TEXT,
  state TEXT NOT NULL DEFAULT 'pending', error TEXT, done_at TEXT);
CREATE INDEX IF NOT EXISTS idx_items_campaign ON campaign_items(campaign_id, state);
CREATE TABLE IF NOT EXISTS logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, campaign_id TEXT, phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '', status TEXT, result TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS segments(name TEXT PRIMARY KEY COLLATE NOCASE, template TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
`);
const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('contacts', 'name', "TEXT NOT NULL DEFAULT ''");        // NB : la colonne contacts.status contient le SEGMENT
addCol('campaign_items', 'name', "TEXT NOT NULL DEFAULT ''");
addCol('campaigns', 'created_by', 'TEXT');

const now = () => new Date().toISOString();
const like = s => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
const toContact = r => ({ id: r.id, phone: r.phone, name: r.name, email: r.email, segment: r.status, lastSentAt: r.last_sent_at });

/* ---------- Segments (groupes libres) ---------- */
const DEFAULT_TEMPLATES = {
  'yes': 'Bonjour {name}, merci pour votre contribution à l’association ! 🙏',
  'no': 'Bonjour {name}, nous serions heureux de vous compter parmi les contributeurs. Souhaitez-vous en savoir plus ?',
  'More information needed': 'Bonjour {name}, voici les informations demandées sur la contribution des membres : ...',
};
const cleanSeg = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 60);
const segments = {
  list: () => db.prepare('SELECT s.name, s.template, (SELECT COUNT(*) FROM contacts c WHERE c.status = s.name) AS count FROM segments s ORDER BY s.position, s.rowid').all(),
  canonical: name => { const r = db.prepare('SELECT name FROM segments WHERE name = ?').get(cleanSeg(name)); return r ? r.name : null; },
  create(name, template = '') {
    const n = cleanSeg(name);
    if (!n) throw new HttpError(400, 'Le nom du segment est vide.');
    if (segments.canonical(n)) throw new HttpError(409, 'Ce segment existe déjà.');
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM segments').get().p;
    db.prepare('INSERT INTO segments(name, template, position) VALUES (?,?,?)').run(n, String(template), pos);
    return n;
  },
  // Retrouve (ou crée) le segment correspondant à une valeur libre ; « oui/non/more… » restent des alias des segments historiques.
  resolve(raw) {
    const n = cleanSeg(raw);
    if (!n) return null;
    const alias = normStatus(n);
    return segments.canonical(n) || (alias && segments.canonical(alias)) || segments.create(n);
  },
  rename: db.transaction((name, newName) => {
    const cur = segments.canonical(name), n = cleanSeg(newName);
    if (!cur) throw new HttpError(404, 'Segment introuvable.');
    if (!n) throw new HttpError(400, 'Le nom du segment est vide.');
    const other = segments.canonical(n);
    if (other && other !== cur) throw new HttpError(409, 'Ce nom est déjà utilisé.');
    db.prepare('UPDATE segments SET name = ? WHERE name = ?').run(n, cur);
    db.prepare('UPDATE contacts SET status = ? WHERE status = ?').run(n, cur);
    return n;
  }),
  setTemplate(name, body) {
    const cur = segments.canonical(name);
    if (!cur) throw new HttpError(404, 'Segment introuvable.');
    db.prepare('UPDATE segments SET template = ? WHERE name = ?').run(String(body), cur);
  },
  remove: db.transaction((name, moveTo) => {
    const cur = segments.canonical(name);
    if (!cur) throw new HttpError(404, 'Segment introuvable.');
    const n = db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE status = ?').get(cur).n;
    if (n) {
      const target = moveTo && segments.canonical(moveTo);
      if (!moveTo) throw new HttpError(409, `Ce segment contient ${n} contact(s) : choisissez où les déplacer.`);
      if (!target || target === cur) throw new HttpError(400, 'Segment de destination invalide.');
      db.prepare('UPDATE contacts SET status = ? WHERE status = ?').run(target, cur);
    }
    db.prepare('DELETE FROM segments WHERE name = ?').run(cur);
  }),
};

/* ---------- Contacts (communs à tous les numéros) ---------- */
const where = ({ segment, q } = {}) => {
  const w = [], args = [];
  if (segment) { w.push('status = ?'); args.push(segment); }
  if (q) {
    const ql = String(q).toLowerCase().trim(), qd = ql.replace(/\D/g, '');
    w.push("(lower(name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'" + (qd ? " OR phone LIKE ? ESCAPE '\\'" : '') + ')');
    args.push(like(ql), like(ql)); if (qd) args.push(like(qd));
  }
  return { sql: w.length ? ' WHERE ' + w.join(' AND ') : '', args };
};
const contacts = {
  list({ segment, q, page = 1, size } = {}) {
    const { sql, args } = where({ segment, q });
    const total = db.prepare('SELECT COUNT(*) AS n FROM contacts' + sql).get(...args).n;
    let query = 'SELECT * FROM contacts' + sql + ' ORDER BY created_at, rowid', a = args;
    if (size) { query += ' LIMIT ? OFFSET ?'; a = [...args, size, (Math.max(1, page) - 1) * size]; }
    return { items: db.prepare(query).all(...a).map(toContact), total };
  },
  all: () => contacts.list().items,
  upsert({ email, name, segment, phone }) {
    const p = normPhone(phone), em = String(email || '').trim(), nm = String(name || '').trim().slice(0, 80);
    if (!p) return { error: 'Numéro invalide' };
    const seg = segments.resolve(segment);
    if (!seg) return { error: 'Segment manquant' };
    const ex = db.prepare('SELECT id FROM contacts WHERE phone = ?').get(p);
    if (ex) {
      db.prepare("UPDATE contacts SET email = CASE WHEN ? != '' THEN ? ELSE email END, name = CASE WHEN ? != '' THEN ? ELSE name END, status = ? WHERE id = ?").run(em, em, nm, nm, seg, ex.id);
      return { updated: true };
    }
    db.prepare('INSERT INTO contacts(id, phone, name, email, status, created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), p, nm, em, seg, now());
    return { added: true };
  },
  update(id, { phone, name, email, segment }) {
    const p = normPhone(phone), seg = segments.resolve(segment);
    if (!db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(id)) throw new HttpError(404, 'Contact introuvable.');
    if (!p) throw new HttpError(400, 'Numéro invalide.');
    if (!seg) throw new HttpError(400, 'Segment manquant.');
    if (db.prepare('SELECT 1 FROM contacts WHERE phone = ? AND id != ?').get(p, id)) throw new HttpError(409, 'Ce numéro existe déjà.');
    db.prepare('UPDATE contacts SET phone = ?, name = ?, email = ?, status = ? WHERE id = ?').run(p, String(name || '').trim().slice(0, 80), String(email || '').trim(), seg, id);
  },
  importRows: db.transaction(rows => rows.map(r => contacts.upsert(r))),
  exists: id => !!db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(id),
  remove: id => db.prepare('DELETE FROM contacts WHERE id = ?').run(id).changes,
  removeMany: db.transaction(ids => ids.reduce((n, id) => n + contacts.remove(id), 0)),
  removeAll: () => db.prepare('DELETE FROM contacts').run().changes,
  resetSent: () => db.prepare('UPDATE contacts SET last_sent_at = NULL').run().changes,
  total: () => db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
  recipients: (segment, skip, limit) => db.prepare(`SELECT * FROM contacts WHERE status = ? ${skip ? 'AND last_sent_at IS NULL' : ''} ORDER BY created_at, rowid LIMIT ?`).all(segment, limit).map(toContact),
  eligible: (segment, skip) => db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE status = ? ${skip ? 'AND last_sent_at IS NULL' : ''}`).get(segment).n,
};

/* ---------- Campagnes persistantes ---------- */
const COUNTS = ['sent', 'failed', 'skipped', 'cancelled', 'pending']
  .map(s => `(SELECT COUNT(*) FROM campaign_items i WHERE i.campaign_id = c.id AND i.state = '${s}') AS ${s}`).join(', ');
const SELECT_C = `SELECT c.*, (SELECT COUNT(*) FROM campaign_items i WHERE i.campaign_id = c.id) AS total, ${COUNTS} FROM campaigns c`;
const RESULT_LABEL = { sent: 'envoyé', skipped: 'ignoré', failed: 'échec' };

const campaigns = {
  create: db.transaction((o, recipients) => {
    const id = crypto.randomUUID(), t = now();
    db.prepare(`INSERT INTO campaigns(id, created_at, updated_at, status, is_test, group_status, message, delay_min, delay_max, session_id, session_label, created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, t, t, 'running', o.isTest ? 1 : 0, o.groupStatus || null, o.message, o.delayMin, o.delayMax, o.sessionId || null, o.sessionLabel || null, o.createdBy || null);
    const ins = db.prepare('INSERT INTO campaign_items(campaign_id, contact_id, phone, email, name, status) VALUES (?,?,?,?,?,?)');
    for (const r of recipients) ins.run(id, r.id || null, r.phone, r.email || '', r.name || '', r.segment || null);
    return id;
  }),
  get: id => db.prepare(`${SELECT_C} WHERE c.id = ?`).get(id),
  unfinished: () => db.prepare(`${SELECT_C} WHERE c.status IN ('running','paused') ORDER BY c.created_at DESC LIMIT 1`).get(),
  latest: () => db.prepare(`${SELECT_C} ORDER BY c.created_at DESC LIMIT 1`).get(),
  list: limit => db.prepare(`${SELECT_C} ORDER BY c.created_at DESC LIMIT ?`).all(limit),
  nextPending: id => db.prepare("SELECT * FROM campaign_items WHERE campaign_id = ? AND state = 'pending' ORDER BY id LIMIT 1").get(id),
  hasPending: id => !!db.prepare("SELECT 1 FROM campaign_items WHERE campaign_id = ? AND state = 'pending' LIMIT 1").get(id),
  setStatus: (id, status, note = null) => db.prepare('UPDATE campaigns SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(status, note, now(), id),
  setSession: (id, sid, label) => db.prepare('UPDATE campaigns SET session_id = ?, session_label = ? WHERE id = ?').run(sid, label, id),
  cancelPending: id => db.prepare("UPDATE campaign_items SET state = 'cancelled' WHERE campaign_id = ? AND state = 'pending'").run(id),
  interruptRunning: () => db.prepare("UPDATE campaigns SET status = 'paused', note = 'Interrompue par un redémarrage du serveur.', updated_at = ? WHERE status = 'running'").run(now()),
  // Résultat d'un destinataire : état, historique et marqueur « déjà contacté » en une seule transaction.
  record: db.transaction((c, item, state, error) => {
    const t = now();
    db.prepare('UPDATE campaign_items SET state = ?, error = ?, done_at = ? WHERE id = ?').run(state, error || null, t, item.id);
    db.prepare('INSERT INTO logs(t, campaign_id, phone, email, status, result, error) VALUES (?,?,?,?,?,?,?)')
      .run(t, c.id, item.phone, item.email, item.status || 'test', RESULT_LABEL[state], error || null);
    if (state === 'sent' && !c.is_test && item.contact_id) db.prepare('UPDATE contacts SET last_sent_at = ? WHERE id = ?').run(t, item.contact_id);
    db.prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?').run(t, c.id);
  }),
};

/* ---------- Historique ---------- */
const logs = {
  recent: n => db.prepare('SELECT t, phone, email, status, result, error FROM logs ORDER BY id DESC LIMIT ?').all(n),
  prune: (keep = 3000) => db.prepare('DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?').run(keep),
};

/* ---------- Migration unique depuis l'ancien db.json ---------- */
function migrateJson() {
  const file = path.join(DATA, 'db.json');
  if (!fs.existsSync(file) || db.prepare("SELECT 1 FROM meta WHERE key = 'json_migrated'").get()) return;
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  db.transaction(() => {
    for (const c of old.contacts || []) {
      const p = normPhone(c.phone), st = normStatus(c.status);
      if (p && st) db.prepare('INSERT OR IGNORE INTO contacts(id, phone, email, status, last_sent_at, created_at) VALUES (?,?,?,?,?,?)')
        .run(c.id || crypto.randomUUID(), p, c.email || '', st, c.lastSentAt || null, now());
    }
    for (const [k, v] of Object.entries(old.templates || {})) db.prepare('INSERT OR REPLACE INTO templates(status, body) VALUES (?,?)').run(k, String(v));
    for (const l of old.logs || []) db.prepare('INSERT INTO logs(t, phone, email, status, result, error) VALUES (?,?,?,?,?,?)')
      .run(l.t || now(), l.phone || '', l.email || '', l.status || null, l.result || '', l.error || null);
    db.prepare("INSERT INTO meta(key, value) VALUES ('json_migrated', ?)").run(now());
  })();
  fs.renameSync(file, file + '.migre');
  console.log('db.json importé dans SQLite (copie conservée : db.json.migre).');
}
migrateJson();

// Premier démarrage avec la nouvelle version : les groupes existants deviennent des segments (modèles conservés).
(function seedSegments() {
  if (db.prepare('SELECT 1 FROM segments').get()) return;
  const old = Object.fromEntries(db.prepare('SELECT status, body FROM templates').all().map(r => [r.status, r.body]));
  const names = [...Object.keys(DEFAULT_TEMPLATES), ...db.prepare('SELECT DISTINCT status FROM contacts').all().map(r => r.status)];
  for (const n of new Set(names)) { try { segments.create(n, old[n] ?? DEFAULT_TEMPLATES[n] ?? ''); } catch {} }
})();

/* ---------- Comptes et sessions de connexion ---------- */
const users = {
  count: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  adminCount: () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n,
  byName: n => db.prepare('SELECT * FROM users WHERE username = ?').get(n),
  byId: id => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  list: () => db.prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY created_at, rowid').all(),
  create({ username, passwordHash, role }) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?,?,?,?,?)').run(id, username, passwordHash, role, now());
    return id;
  },
  setPassword: (id, hash) => db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id),
  setRole: (id, role) => db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id),
  remove: id => db.prepare('DELETE FROM users WHERE id = ?').run(id),
};
const authSessions = {
  create: (tokenHash, userId, expiresAt) => db.prepare('INSERT INTO auth_sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(tokenHash, userId, now(), expiresAt),
  find: tokenHash => db.prepare('SELECT u.id, u.username, u.role FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(tokenHash, now()),
  remove: tokenHash => db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash),
  removeForUser: userId => db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId),
  purge: () => db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now()),
};

module.exports = { contacts, segments, campaigns, logs, users, authSessions, close: () => db.close() };
