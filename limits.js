// Protections anti-blocage : plage horaire, plafond quotidien et montée en charge (fonctions pures, testables).
const { HttpError } = require('./http');

const DEFAULTS = {
  timezone: 'Africa/Douala',
  windowEnabled: false, windowStart: '08:00', windowEnd: '20:00',
  dailyCap: 0,                                   // 0 = pas de plafond
  warmupEnabled: false, warmupStart: 20, warmupStep: 10,   // jour 0 : 20 messages, puis +10 par jour
  optoutReply: 'Vous ne recevrez plus nos messages. Merci.',
  optoutKeywords: 'stop, arret, désinscription, desinscription, unsubscribe',
};
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = s => +s.slice(0, 2) * 60 + +s.slice(3);
const validTz = tz => { try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return true; } catch { return false; } };

function sanitize(p) {
  const o = {};
  if ('timezone' in p) { if (!validTz(p.timezone)) throw new HttpError(400, 'Fuseau horaire invalide (exemple : Africa/Douala).'); o.timezone = p.timezone; }
  for (const k of ['windowEnabled', 'warmupEnabled']) if (k in p) o[k] = !!p[k];
  for (const k of ['windowStart', 'windowEnd']) if (k in p) { if (!HHMM.test(p[k])) throw new HttpError(400, 'Heure invalide (format HH:MM).'); o[k] = p[k]; }
  for (const k of ['dailyCap', 'warmupStart', 'warmupStep']) if (k in p) {
    const n = Math.round(+p[k]);
    if (!(n >= 0 && n <= 5000)) throw new HttpError(400, 'Les plafonds doivent être compris entre 0 et 5000.');
    o[k] = n;
  }
  if ('optoutReply' in p) o.optoutReply = String(p.optoutReply).slice(0, 300);
  if ('optoutKeywords' in p) o.optoutKeywords = String(p.optoutKeywords).slice(0, 300);
  return o;
}
function validate(s) {
  if (s.windowEnabled && s.windowStart === s.windowEnd) throw new HttpError(400, 'L’heure de début et de fin doivent être différentes.');
  if (s.warmupEnabled && s.warmupStart < 1) throw new HttpError(400, 'La montée en charge doit démarrer à 1 message ou plus.');
}

// Heure locale (minutes depuis minuit) et début du jour local, en millisecondes UTC, pour un fuseau donné.
function parts(tz, date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const g = t => +f.find(x => x.type === t).value;
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  const offset = asUtc - Math.floor(date.getTime() / 1000) * 1000;
  return { minutes: g('hour') * 60 + g('minute'), dayStartMs: Date.UTC(g('year'), g('month') - 1, g('day')) - offset };
}
const inWindow = (s, minutes) => {
  const a = toMin(s.windowStart), b = toMin(s.windowEnd);
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;   // plage qui passe minuit acceptée
};
function capFor(s, dayIndex) {
  let cap = s.dailyCap > 0 ? s.dailyCap : Infinity;
  if (s.warmupEnabled) cap = Math.min(cap, s.warmupStart + s.warmupStep * dayIndex);
  return cap;
}
const dayIndex = (s, firstSentMs, p) => (firstSentMs == null ? 0 : Math.max(0, Math.round((p.dayStartMs - parts(s.timezone, new Date(firstSentMs)).dayStartMs) / 86400000)));

// null = envoi autorisé ; sinon { reason, note } (la campagne se met en pause et reprend toute seule).
function check(s, { sentToday = 0, firstSentMs = null } = {}, now = new Date()) {
  const p = parts(s.timezone, now);
  if (s.windowEnabled && !inWindow(s, p.minutes)) return { reason: 'window', note: `Hors plage horaire (${s.windowStart}–${s.windowEnd}, ${s.timezone}) : reprise automatique à ${s.windowStart}.` };
  const cap = capFor(s, dayIndex(s, firstSentMs, p));
  if (sentToday >= cap) return { reason: 'cap', note: `Plafond du jour atteint (${cap} messages${s.warmupEnabled ? ', montée en charge' : ''}) : reprise automatique demain${s.windowEnabled ? ' à ' + s.windowStart : ''}.` };
  return null;
}
function info(s, { sentToday = 0, firstSentMs = null } = {}, now = new Date()) {
  const p = parts(s.timezone, now), cap = capFor(s, dayIndex(s, firstSentMs, p));
  return { ...s, openNow: !s.windowEnabled || inWindow(s, p.minutes), cap: Number.isFinite(cap) ? cap : null, sentToday };
}

// Mots-clés de désinscription : message court qui correspond (sans accents ni ponctuation) à un mot-clé.
const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function isOptOut(body, keywords) {
  const b = norm(body);
  if (!b || b.length > 30) return false;
  return String(keywords).split(',').map(norm).filter(Boolean).some(k => b === k || b.startsWith(k + ' '));
}

module.exports = { DEFAULTS, sanitize, validate, parts, check, info, isOptOut, validTz };
