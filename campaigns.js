// Moteur de campagnes : file d'envoi persistante en base, avec pause, reprise et arrêt.
const db = require('./db');
const { MAX_PER_RUN } = require('./config');
const { normPhone, render } = require('./normalize');
const { HttpError } = require('./http');
const limits = require('./limits');
const webhooks = require('./webhooks');

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Erreurs typiques d'un navigateur qui s'effondre (l'événement « déconnecté » peut arriver juste après).
const CONNECTION_ERROR = /Target closed|Session closed|Protocol error|Execution context|detached Frame|Connection closed|Browser.*(closed|disconnected)/i;

class CampaignRunner {
  constructor(sessions, provider) {
    this.sessions = sessions;
    this.provider = provider;
    this.id = null;          // campagne en cours d'envoi (boucle active)
    this.want = null;        // 'pause' | 'stop' demandé
    this.wake = null;        // interrompt l'attente entre deux messages
    this.currentLabel = '';
    this.loop = null;
  }

  // Après un redémarrage, une campagne « en cours » devient « en pause » : on peut la reprendre.
  init() {
    db.campaigns.interruptRunning();
    // Reprise automatique d'une campagne mise en pause par la plage horaire ou le plafond quotidien.
    const t = setInterval(() => { try { this._tick(); } catch (e) { console.error('[reprise auto]', e.message); } }, +process.env.AUTO_RESUME_CHECK_MS || 60000);
    if (t.unref) t.unref();
  }
  _tick() {
    const c = db.campaigns.unfinished();
    if (c && c.status === 'paused' && c.auto_resume && !this.id && this.provider.isReady() && !this._gate(this._activeSessionId())) this.resume();
  }
  isRunning() { return this.id !== null; }

  view() {
    const c = db.campaigns.unfinished() || db.campaigns.latest();
    if (!c) return null;
    const active = this.id === c.id;
    return {
      id: c.id, status: c.status, note: c.note, createdBy: c.created_by, autoResume: !!c.auto_resume, isTest: !!c.is_test, groupStatus: c.group_status,
      sessionLabel: c.session_label, pausing: active && !!this.want, current: active ? this.currentLabel : '',
      total: c.total, sent: c.sent, failed: c.failed, skipped: c.skipped, cancelled: c.cancelled, pending: c.pending,
    };
  }

  start({ segment, message, testNumber, skipContacted = true, delayMin, delayMax, createdBy }) {
    if (db.campaigns.unfinished()) throw new HttpError(409, 'Une campagne est déjà en cours ou en pause : reprenez-la ou arrêtez-la.');
    this._needClient();
    if (!message || !String(message).trim()) throw new HttpError(400, 'Le message est vide.');
    const min = Math.max(3, +delayMin || 8), max = Math.max(min, +delayMax || 20);
    let list;
    if (testNumber) {
      const p = normPhone(testNumber);
      if (!p) throw new HttpError(400, 'Numéro de test invalide.');
      list = [{ phone: p, email: 'test', name: 'Test' }];
    } else {
      const seg = db.segments.canonical(segment);
      if (!seg) throw new HttpError(400, 'Choisissez un segment.');
      segment = seg;
      list = db.contacts.recipients(seg, !!skipContacted, MAX_PER_RUN);
    }
    if (!list.length) throw new HttpError(400, 'Aucun destinataire pour ce filtre.');
    const s = this._session();
    const id = db.campaigns.create({ isTest: !!testNumber, groupStatus: testNumber ? null : segment, message: String(message), createdBy,
      delayMin: min, delayMax: max, sessionId: s.id, sessionLabel: s.label }, list);
    this._run(id);
    return { started: list.length, id };
  }

  resume() {
    const c = db.campaigns.unfinished();
    if (!c) throw new HttpError(404, 'Aucune campagne à reprendre.');
    if (this.id) return { ok: true };
    this._needClient();
    const s = this._session();
    db.campaigns.setSession(c.id, s.id, s.label);   // la reprise utilise le numéro actuellement actif
    db.campaigns.setStatus(c.id, 'running');
    this._run(c.id);
    return { resumed: c.pending };
  }

  pause() { if (this.id) this._ask('pause'); }

  stop() {
    if (this.id) return this._ask('stop');
    const c = db.campaigns.unfinished();      // campagne déjà en pause : on l'annule directement
    if (c) this._end(c.id, 'stopped');
  }

  // Envoi d'un message isolé (API) : mêmes protections que les campagnes.
  async sendOne({ phone, message, name }) {
    this._needClient();
    const p = normPhone(phone);
    if (!p) throw new HttpError(400, 'Numéro invalide.');
    if (!message || !String(message).trim()) throw new HttpError(400, 'Le message est vide.');
    const known = db.contacts.byPhone(p);
    if (known && known.optedOut) throw new HttpError(409, 'Ce contact s’est désinscrit.');
    const sid = this._activeSessionId(), g = this._gate(sid);
    if (g) throw new HttpError(429, g.note);
    const chat = await this.provider.resolve(p);
    if (!chat) { db.logs.add({ sessionId: sid, phone: p, result: 'ignoré', error: 'Pas de compte WhatsApp' }); throw new HttpError(422, 'Ce numéro n’a pas de compte WhatsApp.'); }
    await this.provider.send(chat, render(String(message), { name: name || (known && known.name) || '', email: (known && known.email) || '', phone: p }));
    db.logs.add({ sessionId: sid, phone: p, email: (known && known.email) || '', result: 'envoyé' });
    return { sent: true };
  }

  /* ---------- interne ---------- */
  _needClient() {
    if (!this.provider.isReady()) throw new HttpError(400, 'WhatsApp n’est pas connecté.');
  }
  _session() {
    const s = this.sessions.list().sessions.find(x => x.active);
    return { id: s ? s.id : null, label: s ? s.name + (s.number ? ' (+' + s.number + ')' : '') : null };
  }
  _activeSessionId() { return this._session().id; }
  // Plage horaire / plafond quotidien (par numéro) : null = envoi autorisé.
  _ctx(sessionId, s) {
    const p = limits.parts(s.timezone);
    return { sentToday: db.logs.sentSince(sessionId, new Date(p.dayStartMs).toISOString()), firstSentMs: db.logs.firstSent(sessionId) };
  }
  _gate(sessionId) { const s = db.settings.get(); return limits.check(s, this._ctx(sessionId, s)); }
  limitsInfo() { const s = db.settings.get(), sid = this._activeSessionId(); return limits.info(s, this._ctx(sid, s)); }
  _ask(what) { this.want = what; if (this.wake) this.wake(); }
  _wait(ms) { return new Promise(r => { const t = setTimeout(r, ms); this.wake = () => { clearTimeout(t); r(); }; }); }
  _run(id) {
    this.id = id; this.want = null;
    this.loop = this._loop(id).catch(e => { console.error('[campagne]', e); this._end(id, 'paused', 'Erreur interne : ' + e.message); });
  }
  settled() { return this.loop || Promise.resolve(); }
  _end(id, status, note, autoResume = false) {
    if (status === 'stopped') db.campaigns.cancelPending(id);
    db.campaigns.setStatus(id, status, note || null, autoResume);
    if (status !== 'paused') {
      db.logs.prune();
      const p = db.campaigns.get(id);
      webhooks.emit('campaign.finished', { id, status, isTest: !!p.is_test, segment: p.group_status, sent: p.sent, skipped: p.skipped, failed: p.failed, cancelled: p.cancelled });
    }
    if (this.id === id) { this.id = null; this.want = null; this.wake = null; this.currentLabel = ''; }
  }

  async _loop(id) {
    const c = db.campaigns.get(id);
    for (;;) {
      if (this.want) return this._end(id, this.want === 'stop' ? 'stopped' : 'paused');
      const item = db.campaigns.nextPending(id);
      if (!item) return this._end(id, 'completed');
      if (!this.provider.isReady()) return this._end(id, 'paused', 'WhatsApp déconnecté : campagne mise en pause.');
      const g = this._gate(c.session_id);
      if (g) return this._end(id, 'paused', g.note, true);
      this.currentLabel = item.email || item.phone;
      let state, error = null;
      if (item.contact_id && !db.contacts.exists(item.contact_id)) { state = 'skipped'; error = 'Contact supprimé'; }
      else if (item.contact_id && db.contacts.isOptedOut(item.contact_id)) { state = 'skipped'; error = 'Désinscrit'; }
      else {
        try {
          const chat = await this.provider.resolve(item.phone);
          if (!chat) { state = 'skipped'; error = 'Pas de compte WhatsApp'; }
          else { await this.provider.send(chat, render(c.message, item)); state = 'sent'; }
        } catch (e) {
          let lost = !this.provider.isReady();
          if (!lost && CONNECTION_ERROR.test(String(e.message))) { await sleep(2000); lost = !this.provider.isReady(); }
          if (lost) return this._end(id, 'paused', 'WhatsApp déconnecté pendant l’envoi : campagne mise en pause.');
          state = 'failed'; error = String(e.message || e).slice(0, 200);
        }
      }
      db.campaigns.record(c, item, state, error);
      if (db.campaigns.hasPending(id) && !this.want) await this._wait((c.delay_min + Math.random() * (c.delay_max - c.delay_min)) * 1000);
    }
  }
}

module.exports = CampaignRunner;
