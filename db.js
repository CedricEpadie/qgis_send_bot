// Stockage SQLite : contacts partagés par tous les numéros, modèles, campagnes persistantes, historique.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA, STATUSES } = require('./config');
const { normPhone, normStatus } = require('./normalize');

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
`);

const now = () => new Date().toISOString();
const like = s => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
const toContact = r => ({ id: r.id, phone: r.phone, email: r.email, status: r.status, lastSentAt: r.last_sent_at });

/* ---------- Contacts (communs à tous les numéros) ---------- */
const contacts = {
  list({ status, q } = {}) {
    const where = [], args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (q) {
      const ql = String(q).toLowerCase().trim(), qd = ql.replace(/\D/g, '');
      where.push(qd ? "(lower(email) LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')" : "lower(email) LIKE ? ESCAPE '\\'");
      args.push(like(ql)); if (qd) args.push(like(qd));
    }
    const sql = 'SELECT * FROM contacts' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at, rowid';
    return db.prepare(sql).all(...args).map(toContact);
  },
  upsert({ email, status, phone }) {
    const p = normPhone(phone), st = normStatus(status), em = String(email || '').trim();
    if (!p) return { error: 'Numéro invalide' };
    if (!st) return { error: 'Statut invalide (yes / no / More information needed)' };
    const ex = db.prepare('SELECT id FROM contacts WHERE phone = ?').get(p);
    if (ex) { db.prepare("UPDATE contacts SET email = CASE WHEN ? != '' THEN ? ELSE email END, status = ? WHERE id = ?").run(em, em, st, ex.id); return { updated: true }; }
    db.prepare('INSERT INTO contacts(id, phone, email, status, created_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), p, em, st, now());
    return { added: true };
  },
  importRows: db.transaction(rows => rows.map(r => contacts.upsert(r))),
  exists: id => !!db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(id),
  remove: id => db.prepare('DELETE FROM contacts WHERE id = ?').run(id).changes,
  removeMany: db.transaction(ids => ids.reduce((n, id) => n + contacts.remove(id), 0)),
  removeAll: () => db.prepare('DELETE FROM contacts').run().changes,
  resetSent: () => db.prepare('UPDATE contacts SET last_sent_at = NULL').run().changes,
  total: () => db.prepare('SELECT COUNT(*) n FROM contacts').get().n,
  counts() {
    const out = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) n FROM contacts GROUP BY status').all()) if (r.status in out) out[r.status] = r.n;
    return out;
  },
  recipients(status, skipContacted, limit) {
    return db.prepare(`SELECT * FROM contacts WHERE status = ? ${skipContacted ? 'AND last_sent_at IS NULL' : ''} ORDER BY created_at, rowid LIMIT ?`)
      .all(status, limit).map(toContact);
  },
};

/* ---------- Modèles de message ---------- */
const DEFAULT_TEMPLATES = {
  'yes': 'Bonjour, merci pour votre contribution à l’association ! 🙏',
  'no': 'Bonjour, nous serions heureux de vous compter parmi les contributeurs. Souhaitez-vous en savoir plus ?',
  'More information needed': 'Bonjour, voici les informations demandées sur la contribution des membres : ...',
};
const templates = {
  all() {
    const out = { ...DEFAULT_TEMPLATES };
    for (const r of db.prepare('SELECT status, body FROM templates').all()) out[r.status] = r.body;
    return out;
  },
  set: db.transaction(obj => {
    for (const [k, v] of Object.entries(obj || {}))
      if (STATUSES.includes(k)) db.prepare('INSERT INTO templates(status, body) VALUES (?,?) ON CONFLICT(status) DO UPDATE SET body = excluded.body').run(k, String(v));
  }),
};

/* ---------- Campagnes persistantes ---------- */
const COUNTS = ['sent', 'failed', 'skipped', 'cancelled', 'pending']
  .map(s => `(SELECT COUNT(*) FROM campaign_items i WHERE i.campaign_id = c.id AND i.state = '${s}') AS ${s}`).join(', ');
const SELECT_C = `SELECT c.*, (SELECT COUNT(*) FROM campaign_items i WHERE i.campaign_id = c.id) AS total, ${COUNTS} FROM campaigns c`;
const RESULT_LABEL = { sent: 'envoyé', skipped: 'ignoré', failed: 'échec' };

const campaigns = {
  create: db.transaction((o, recipients) => {
    const id = crypto.randomUUID(), t = now();
    db.prepare(`INSERT INTO campaigns(id, created_at, updated_at, status, is_test, group_status, message, delay_min, delay_max, session_id, session_label)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, t, t, 'running', o.isTest ? 1 : 0, o.groupStatus || null, o.message, o.delayMin, o.delayMax, o.sessionId || null, o.sessionLabel || null);
    const ins = db.prepare('INSERT INTO campaign_items(campaign_id, contact_id, phone, email, status) VALUES (?,?,?,?,?)');
    for (const r of recipients) ins.run(id, r.id || null, r.phone, r.email || '', r.status || null);
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
    templates.set(old.templates);
    for (const l of old.logs || []) db.prepare('INSERT INTO logs(t, phone, email, status, result, error) VALUES (?,?,?,?,?,?)')
      .run(l.t || now(), l.phone || '', l.email || '', l.status || null, l.result || '', l.error || null);
    db.prepare("INSERT INTO meta(key, value) VALUES ('json_migrated', ?)").run(now());
  })();
  fs.renameSync(file, file + '.migre');
  console.log('db.json importé dans SQLite (copie conservée : db.json.migre).');
}
migrateJson();

module.exports = { contacts, templates, campaigns, logs, close: () => db.close() };
