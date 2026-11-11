// Webhooks sortants : signature HMAC, nouvelles tentatives, et protection contre les adresses internes (SSRF).
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const db = require('./db');
const { HttpError } = require('./http');

const EVENTS = ['message.received', 'contact.opted_out', 'campaign.finished'];
const ALLOW_PRIVATE = process.env.WEBHOOK_ALLOW_PRIVATE === '1';   // pour un récepteur placé sur le même serveur
const RETRIES = (process.env.WEBHOOK_RETRY_MS || '2000,10000,60000').split(',').map(Number);

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const dotted = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/), hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (dotted) return isPrivate(dotted[1]);
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return isPrivate([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}
const bare = host => host.replace(/^\[|\]$/g, '');

// Résolution DNS contrôlée au moment de la connexion : empêche aussi le « DNS rebinding ».
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!ALLOW_PRIVATE && addrs.some(a => isPrivate(a.address))) return cb(new Error('adresse interne interdite'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'Adresse (URL) invalide.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'L’adresse doit commencer par http:// ou https://.');
  if (u.username || u.password) throw new HttpError(400, 'Les identifiants dans l’adresse ne sont pas autorisés.');
  const host = bare(u.hostname);
  if (!ALLOW_PRIVATE) {
    if (net.isIP(host)) { if (isPrivate(host)) throw new HttpError(400, 'Les adresses internes ne sont pas autorisées.'); }
    else {
      let addrs; try { addrs = await dns.promises.lookup(host, { all: true }); } catch { throw new HttpError(400, 'Nom de domaine introuvable.'); }
      if (addrs.some(a => isPrivate(a.address))) throw new HttpError(400, 'Cette adresse pointe vers le réseau interne : refusée.');
    }
  }
  return u.toString();
}

function post(hook, body, event, id) {
  return new Promise((resolve, reject) => {
    const u = new URL(hook.url), host = bare(u.hostname);
    if (!ALLOW_PRIVATE && net.isIP(host) && isPrivate(host)) return reject(new Error('adresse interne interdite'));
    const sig = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
    const req = (u.protocol === 'https:' ? https : http).request({
      hostname: host, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', lookup: safeLookup, timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'wa-broadcast-webhook', 'X-Webhook-Event': event, 'X-Webhook-Id': id, 'X-Webhook-Signature': sig },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
    req.end(body);
  });
}

// Envoie un événement avec jusqu'à 3 nouvelles tentatives (en mémoire : non conservées après un redémarrage).
function send(hook, event, data) {
  const id = crypto.randomUUID(), body = JSON.stringify({ id, event, createdAt: new Date().toISOString(), data });
  let n = 0;
  const attempt = async () => {
    try {
      const st = await post(hook, body, event, id);
      if (st >= 200 && st < 300) return db.webhooks.result(hook.id, 'OK ' + st);
      throw new Error('HTTP ' + st);
    } catch (e) {
      db.webhooks.result(hook.id, 'échec : ' + e.message);
      if (n < RETRIES.length) { const t = setTimeout(attempt, RETRIES[n++]); if (t.unref) t.unref(); }
    }
  };
  return attempt();
}
const emit = (event, data) => { for (const h of db.webhooks.forEvent(event)) send(h, event, data).catch(() => {}); };

async function create(url, events) {
  const evs = (Array.isArray(events) ? events : []).filter(e => EVENTS.includes(e));
  if (!evs.length) throw new HttpError(400, 'Choisissez au moins un événement.');
  const clean = await validateUrl(url), secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  return { id: db.webhooks.create(clean, secret, evs), secret };
}
async function ping(id) {
  const h = db.webhooks.get(id);
  if (!h) throw new HttpError(404, 'Webhook introuvable.');
  const body = JSON.stringify({ id: crypto.randomUUID(), event: 'ping', createdAt: new Date().toISOString(), data: { message: 'Test depuis WA Broadcast' } });
  try {
    const st = await post(h, body, 'ping', 'test');
    db.webhooks.result(h.id, st >= 200 && st < 300 ? 'OK ' + st : 'échec : HTTP ' + st);
    return { status: st };
  } catch (e) { db.webhooks.result(h.id, 'échec : ' + e.message); throw new HttpError(502, 'Le test a échoué : ' + e.message); }
}

module.exports = { EVENTS, isPrivate, validateUrl, create, emit, ping };
