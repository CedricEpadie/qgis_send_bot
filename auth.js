// Comptes utilisateurs : mots de passe hachés (scrypt asynchrone), sessions par cookie, limitation des tentatives.
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./http');

const TTL = 7 * 24 * 3600 * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isProd = process.env.NODE_ENV === 'production';

/* ---------- Hachage scrypt : asynchrone et borné (ne bloque jamais le serveur) ---------- */
const PARAMS = { N: 2 ** 16, r: 8, p: 2 };               // ≈ 64 Mo et ~0,2 s par mot de passe (recommandation OWASP)
const LEGACY = { N: 16384, r: 8, p: 1 };                 // anciens hachages « sel:empreinte »
let running = 0;
const waiting = [];
const slot = () => new Promise((res, rej) => {
  if (running < 2) { running++; return res(); }          // au plus 2 hachages en parallèle
  if (waiting.length >= 20) return rej(new HttpError(503, 'Serveur occupé, réessayez dans un instant.'));
  waiting.push(res);
});
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
const derive = async (pw, salt, prm) => {
  await slot();
  try { return await new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { ...prm, maxmem: 128 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k)))); }
  finally { release(); }
};
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16), k = await derive(pw, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('hex'), k.toString('hex')].join('$');
}
function parseHash(stored) {
  const s = String(stored);
  if (s.startsWith('scrypt$')) { const [, N, r, p, salt, hash] = s.split('$'); return { prm: { N: +N, r: +r, p: +p }, salt, hash }; }
  const [salt, hash] = s.split(':');
  return { prm: LEGACY, salt, hash };
}
async function verifyPassword(pw, stored) {
  const { prm, salt, hash } = parseHash(stored);
  if (!salt || !hash) return false;
  const key = await derive(pw, Buffer.from(salt, 'hex'), prm), want = Buffer.from(hash, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}
const needsRehash = stored => { const { prm } = parseHash(stored); return prm.N !== PARAMS.N || prm.r !== PARAMS.r || prm.p !== PARAMS.p; };
let dummy;                                               // égalise le temps de réponse si l'utilisateur n'existe pas
const dummyHash = () => (dummy = dummy || hashPassword('mot-de-passe-factice'));

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères.');
  if (pw.length > 200) throw new HttpError(400, 'Mot de passe trop long.');
}
function checkUsername(u) {
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(String(u || ''))) throw new HttpError(400, 'Identifiant : 3 à 40 caractères (lettres, chiffres, . _ -).');
}

/* ---------- Limitation des échecs : par adresse, par adresse + identifiant, par identifiant ---------- */
const WINDOW = 10 * 60 * 1000;
const fails = new Map();
const over = (key, max) => { const f = fails.get(key); return !!f && Date.now() - f.t < WINDOW && f.n >= max; };
const bump = key => { const f = fails.get(key); if (!f || Date.now() - f.t >= WINDOW) fails.set(key, { n: 1, t: Date.now() }); else f.n++; };
const wait = key => Math.max(1, Math.ceil((WINDOW - (Date.now() - fails.get(key).t)) / 60000));
function throttle(rules) {
  for (const [key, max] of rules) if (over(key, max)) throw new HttpError(429, `Trop de tentatives. Réessayez dans ${wait(key)} min.`);
}
const sweep = setInterval(() => { for (const [k, f] of fails) if (Date.now() - f.t >= WINDOW) fails.delete(k); }, WINDOW);
if (sweep.unref) sweep.unref();
const loginRules = (ip, user) => [[`ip:${ip}`, 20], [`ipu:${ip}|${user}`, 5], [`u:${user}`, 100]];

async function bootstrap() {
  if (db.users.count()) return;
  if (!cfg.APP_PASSWORD) { console.error('Définissez APP_PASSWORD dans .env pour créer le premier compte administrateur.'); process.exit(1); }
  db.users.create({ username: cfg.APP_USER, passwordHash: await hashPassword(cfg.APP_PASSWORD), role: 'admin' });
  console.log(`Compte administrateur « ${cfg.APP_USER} » créé à partir du fichier .env (modifiable ensuite dans l’application).`);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.authSessions.create(sha(token), userId, new Date(Date.now() + TTL).toISOString());
  db.authSessions.purge();
  return token;
}
async function login(username, password, ip) {
  const name = String(username || '').toLowerCase().slice(0, 60), rules = loginRules(ip, name);
  throttle(rules);                                       // refus avant tout calcul coûteux
  const u = db.users.byName(String(username || ''));
  const stored = u ? u.password_hash : await dummyHash();
  const ok = (await verifyPassword(String(password || ''), stored)) && !!u;
  if (!ok) {
    for (const [key] of rules) bump(key);
    console.warn('[sécurité] échec de connexion', JSON.stringify({ ip, utilisateur: name }));
    throw new HttpError(401, 'Identifiant ou mot de passe incorrect.');
  }
  fails.delete(rules[1][0]);
  if (needsRehash(u.password_hash)) hashPassword(String(password)).then(h => db.users.setPassword(u.id, h)).catch(() => {});
  return { token: createSession(u.id), user: { id: u.id, username: u.username, role: u.role } };
}
// Vérifie le mot de passe actuel d'un utilisateur connecté (changement de mot de passe) avec limitation des essais.
async function confirmPassword(userId, password) {
  const rules = [[`pw:${userId}`, 5]];
  throttle(rules);
  const u = db.users.byId(userId);
  if (!(await verifyPassword(String(password || ''), u.password_hash))) { bump(rules[0][0]); return false; }
  fails.delete(rules[0][0]);
  return true;
}

/* ---------- Cookie de session ---------- */
const secureFor = req => cfg.COOKIE_SECURE === '1' || (cfg.COOKIE_SECURE !== '0' && (req.secure || isProd));
const readCookie = (req, name) => {
  const c = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return c ? c.slice(name.length + 1) : null;
};
const sid = req => readCookie(req, '__Host-sid') || readCookie(req, 'sid');
const attrs = (secure, maxAgeMs) => `HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
// En HTTPS : cookie « __Host- » (jamais envoyé à un sous-domaine, toujours Secure).
const setCookie = (req, res, token) => { const s = secureFor(req); res.append('Set-Cookie', `${s ? '__Host-sid' : 'sid'}=${token}; ${attrs(s, TTL)}`); };
const clearCookies = (req, res) => { res.append('Set-Cookie', `__Host-sid=; ${attrs(true, 0)}`); res.append('Set-Cookie', `sid=; ${attrs(false, 0)}`); };
const current = req => { const t = sid(req); return t ? db.authSessions.find(sha(t)) : null; };

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
  try { host = new URL(req.headers.origin).host; } catch { /* origine illisible : refusée plus bas */ }
  if (host && (host === req.get('host') || host === req.get('x-forwarded-host'))) return next();
  res.status(403).json({ error: 'Origine refusée.' });
};

/* ---------- Clés d'API (en-tête « Authorization: Bearer wab_… ») : 120 requêtes / minute par clé ---------- */
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
  newApiKey, apiKeyAuth, bootstrap, login, createSession, hashPassword, verifyPassword, confirmPassword, checkPassword, checkUsername,
  sha, readCookie, setCookie, clearCookies, current, require: require_, page, requireRole, originCheck,
};
