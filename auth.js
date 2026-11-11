// Comptes utilisateurs : mots de passe hachés (scrypt), sessions par cookie, limitation des tentatives.
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./http');

const TTL = 7 * 24 * 3600 * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

const hashPassword = pw => {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
};
const verifyPassword = (pw, stored) => {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), want = Buffer.from(h, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
};
const DUMMY = hashPassword('mot-de-passe-factice');     // égalise le temps de réponse si l'utilisateur n'existe pas

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères.');
  if (pw.length > 200) throw new HttpError(400, 'Mot de passe trop long.');
}
function checkUsername(u) {
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(String(u || ''))) throw new HttpError(400, 'Identifiant : 3 à 40 caractères (lettres, chiffres, . _ -).');
}

/* ---- limitation des tentatives : 5 échecs / 10 min par adresse et identifiant ---- */
const fails = new Map(), WINDOW = 10 * 60 * 1000, MAX_FAILS = 5;
const throttle = key => {
  const f = fails.get(key);
  if (f && Date.now() - f.t < WINDOW && f.n >= MAX_FAILS) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${Math.ceil((WINDOW - (Date.now() - f.t)) / 60000)} min.`);
};
const addFail = key => { const f = fails.get(key); if (!f || Date.now() - f.t >= WINDOW) fails.set(key, { n: 1, t: Date.now() }); else f.n++; };

function bootstrap() {
  if (db.users.count()) return;
  if (!cfg.APP_PASSWORD) { console.error('Définissez APP_PASSWORD dans .env pour créer le premier compte administrateur.'); process.exit(1); }
  db.users.create({ username: cfg.APP_USER, passwordHash: hashPassword(cfg.APP_PASSWORD), role: 'admin' });
  console.log(`Compte administrateur « ${cfg.APP_USER} » créé à partir du fichier .env (modifiable ensuite dans l’application).`);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.authSessions.create(sha(token), userId, new Date(Date.now() + TTL).toISOString());
  db.authSessions.purge();
  return token;
}
function login(username, password, ip) {
  const key = ip + '|' + String(username || '').toLowerCase();
  throttle(key);
  const u = db.users.byName(String(username || ''));
  const ok = verifyPassword(String(password || ''), u ? u.password_hash : DUMMY) && !!u;
  if (!ok) { addFail(key); throw new HttpError(401, 'Identifiant ou mot de passe incorrect.'); }
  fails.delete(key);
  return { token: createSession(u.id), user: { id: u.id, username: u.username, role: u.role } };
}

const readCookie = (req, name) => {
  const c = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return c ? c.slice(name.length + 1) : null;
};
const setCookie = (req, res, token, maxAgeMs = TTL) =>
  res.append('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${req.secure ? '; Secure' : ''}`);
const current = req => { const t = readCookie(req, 'sid'); return t ? db.authSessions.find(sha(t)) : null; };

const require_ = (req, res, next) => {
  const u = current(req);
  if (!u) return res.status(401).json({ error: 'Connexion requise.' });
  req.user = u; next();
};
const page = (req, res, next) => {
  const u = current(req);
  if (!u) return res.redirect('/login');
  req.user = u; next();
};
const requireRole = role => (req, res, next) =>
  req.user && req.user.role === role ? next() : res.status(403).json({ error: 'Action réservée aux administrateurs.' });

// Défense en profondeur (le cookie SameSite=Lax protège déjà) : refuse une requête d'écriture venant d'un autre site.
const originCheck = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
  let host = null;
  try { host = new URL(req.headers.origin).host; } catch {}
  if (host && (host === req.get('host') || host === req.get('x-forwarded-host'))) return next();
  res.status(403).json({ error: 'Origine refusée.' });
};

/* ---- clés d'API (en-tête « Authorization: Bearer wab_… ») : 120 requêtes / minute par clé ---- */
const newApiKey = () => { const key = 'wab_' + crypto.randomBytes(24).toString('hex'); return { key, prefix: key.slice(0, 8), hash: sha(key) }; };
const apiCalls = new Map();
const apiKeyAuth = (req, res, next) => {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i), k = m && db.apiKeys.byHash(sha(m[1]));
  if (!k) return res.status(401).json({ error: 'Clé d’API invalide ou manquante.' });
  const now = Date.now(), r = apiCalls.get(k.id);
  if (!r || now - r.t >= 60000) apiCalls.set(k.id, { n: 1, t: now });
  else if (++r.n > 120) return res.status(429).json({ error: 'Trop de requêtes (120 par minute).' });
  db.apiKeys.touch(k.id);
  req.user = { id: null, username: 'api:' + k.name, role: 'member' };
  next();
};

module.exports = {
  newApiKey, apiKeyAuth, bootstrap, login, createSession, hashPassword, verifyPassword, checkPassword, checkUsername,
  sha, readCookie, setCookie, current, require: require_, page, requireRole, originCheck,
};
