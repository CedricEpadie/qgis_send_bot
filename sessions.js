// Gestion des sessions WhatsApp : un dossier par numéro, un seul navigateur actif à la fois.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const MAX_ATTEMPTS = 3;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

class SessionManager extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dir = path.join(dataDir, 'session');            // dataPath de LocalAuth
    this.metaFile = path.join(dataDir, 'sessions.json');
    this.meta = [];                                      // [{id, name, number, createdAt}]
    this.activeId = null;
    this.rt = new Map();                                 // id -> état d'exécution (navigateur lancé)
    this.chain = Promise.resolve();
  }

  // ---------- démarrage ----------
  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.metaFile)) {
      const m = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      this.meta = m.sessions || [];
      this.activeId = m.activeId || null;
    } else {
      const legacy = path.join(this.dir, 'session');     // ancien format sans clientId
      if (fs.existsSync(legacy)) {
        fs.renameSync(legacy, path.join(this.dir, 'session-default'));
        this.meta = [{ id: 'default', name: 'Compte principal', number: null, createdAt: Date.now() }];
        this.activeId = 'default';
      } else {
        this.activeId = this._create('Compte principal').id;
      }
      this._save();
    }
    if (this.activeId && this._find(this.activeId)) this._start(this.activeId);
  }

  // ---------- lecture ----------
  list() {
    return {
      activeId: this.activeId,
      sessions: this.meta.map(s => {
        const r = this.rt.get(s.id);
        return { id: s.id, name: s.name, number: s.number, active: s.id === this.activeId,
                 status: r ? r.status : 'stopped', error: r ? r.error : null };
      }),
    };
  }
  activeState() {
    const r = this.activeId && this.rt.get(this.activeId);
    const s = this.activeId && this._find(this.activeId);
    if (!s) return { id: null, status: 'none', qr: null, number: null, error: null };
    if (!r) return { id: s.id, status: 'stopped', qr: null, number: s.number, error: null };
    return { id: s.id, status: r.status, qr: r.qr, number: r.number || s.number, error: r.error };
  }
  readyClient() {
    const r = this.activeId && this.rt.get(this.activeId);
    return r && r.status === 'ready' ? r.client : null;
  }

  // ---------- actions (sérialisées) ----------
  add(name) { return this._lock(async () => { const s = this._create(name); await this._activate(s.id); return s; }); }
  activate(id) { return this._lock(() => { this._need(id); return this._activate(id); }); }
  restart(id) { return this._lock(async () => { this._need(id); await this._stop(id); await this._activate(id); }); }
  rename(id, name) {
    const s = this._need(id);
    s.name = String(name || '').trim().slice(0, 40) || s.name;
    this._save(); return s;
  }
  reset(id) {               // nouveau QR code : efface la session de ce numéro
    return this._lock(async () => {
      this._need(id);
      await this._logoutIfReady(id);
      await this._stop(id);
      this._rmDir(id);
      this._setNumber(id, null);
      if (id === this.activeId) this._start(id);
    });
  }
  remove(id) {
    return this._lock(async () => {
      this._need(id);
      await this._logoutIfReady(id);
      await this._stop(id);
      this._rmDir(id);
      this.meta = this.meta.filter(s => s.id !== id);
      if (this.activeId === id) {
        this.activeId = this.meta.length ? this.meta[0].id : null;
        if (this.activeId) this._start(this.activeId);
      }
      this._save();
    });
  }
  async shutdown() {
    await Promise.all([...this.rt.keys()].map(id => this._stop(id)));
  }

  // ---------- internes ----------
  _lock(fn) { const run = this.chain.then(fn); this.chain = run.catch(() => {}); return run; }
  _find(id) { return this.meta.find(s => s.id === id); }
  _need(id) { const s = this._find(id); if (!s) throw new Error('Session introuvable.'); return s; }
  _create(name) {
    const s = { id: crypto.randomBytes(4).toString('hex'), name: String(name || '').trim().slice(0, 40) || `Numéro ${this.meta.length + 1}`, number: null, createdAt: Date.now() };
    this.meta.push(s); this._save(); return s;
  }
  _save() {
    const tmp = this.metaFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ activeId: this.activeId, sessions: this.meta }, null, 2));
    fs.renameSync(tmp, this.metaFile);
  }
  _setNumber(id, number) { const s = this._find(id); if (s) { s.number = number; this._save(); } }
  _rmDir(id) { fs.rmSync(path.join(this.dir, 'session-' + id), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }

  async _activate(id) {
    for (const other of [...this.rt.keys()]) if (other !== id) await this._stop(other); // un seul Chromium à la fois
    this.activeId = id; this._save();
    if (!this.rt.has(id)) this._start(id);
  }
  async _logoutIfReady(id) {
    const r = this.rt.get(id);
    if (r && r.status === 'ready') { try { await withTimeout(r.client.logout(), 10000); } catch {} }
  }
  async _stop(id) {
    const r = this.rt.get(id); if (!r) return;
    clearTimeout(r.timer); this.rt.delete(id);          // les callbacks de cet état deviennent « périmés »
    await this._kill(r.client);
  }
  async _kill(client) {
    if (!client) return;
    try { await withTimeout(client.destroy(), 10000); }
    catch { try { client.pupBrowser && client.pupBrowser.process() && client.pupBrowser.process().kill('SIGKILL'); } catch {} }
  }

  _start(id) {
    const old = this.rt.get(id);
    if (old) clearTimeout(old.timer);
    const rt = { id, status: 'starting', qr: null, number: null, error: null, attempts: old ? old.attempts : 0, timer: null, client: null };
    this.rt.set(id, rt);
    const live = () => this.rt.get(id) === rt;
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: id, dataPath: this.dir }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
    });
    rt.client = client;
    client.on('qr', async qr => { if (!live()) return; rt.status = 'qr'; rt.error = null; rt.qr = await QRCode.toDataURL(qr, { width: 280 }); });
    client.on('authenticated', () => { if (!live()) return; rt.status = 'authenticated'; rt.qr = null; rt.error = null; });
    client.on('ready', () => {
      if (!live()) return;
      rt.status = 'ready'; rt.qr = null; rt.error = null; rt.attempts = 0;
      rt.number = client.info && client.info.wid ? client.info.wid.user : null;
      this._setNumber(id, rt.number);
    });
    // Messages reçus (hors groupes, statuts et messages envoyés par nous) : relayés à l'application.
    client.on('message', async msg => {
      if (!live()) return;
      try {
        const from = String(msg.from || '');
        if (msg.fromMe || msg.isStatus || from.endsWith('@g.us') || from === 'status@broadcast') return;
        let phone = from.split('@')[0];
        if (from.endsWith('@lid')) { const ct = await msg.getContact(); phone = ct && ct.number; }   // identifiants masqués : on retrouve le numéro
        if (!phone) return;
        this.emit('message', { sessionId: id, phone, body: String(msg.body || ''), type: msg.type });
      } catch (e) { console.error(`[session ${id}] message entrant :`, e.message); }
    });
    client.on('auth_failure', msg => live() && this._fail(rt, new Error('Échec d’authentification : ' + msg)));
    client.on('disconnected', reason => live() && this._fail(rt, new Error('Déconnecté (' + reason + ')')));
    client.initialize().catch(e => live() && this._fail(rt, e));
  }

  _fail(rt, e) {
    console.error(`[session ${rt.id}]`, e);
    rt.status = 'error'; rt.qr = null; rt.number = null;
    rt.error = String((e && e.message) || e).slice(0, 300);
    this._kill(rt.client);
    if (rt.attempts >= MAX_ATTEMPTS) { rt.error += ' — nouvelle tentative manuelle requise.'; return; }
    const delay = 5000 * 2 ** rt.attempts++;
    rt.timer = setTimeout(() => { if (this.rt.get(rt.id) === rt && this.activeId === rt.id) this._start(rt.id); }, delay);
  }
}

module.exports = SessionManager;
