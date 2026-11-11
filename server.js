const express = require('express');
const path = require('path');
const { PORT, DATA, MAX_PER_RUN } = require('./config');
const db = require('./db');
const auth = require('./auth');
const SessionManager = require('./sessions');
const CampaignRunner = require('./campaigns');
const provider = require('./providers/whatsappweb');

auth.bootstrap();
const sessions = new SessionManager({ dataDir: DATA });
const messenger = provider(sessions);
const runner = new CampaignRunner(sessions, messenger);
require('./inbound')(sessions, messenger);
runner.init();
sessions.init().catch(e => console.error('Initialisation des sessions :', e));

const app = express();
app.set('trust proxy', 1);                       // derrière Caddy / Nginx : HTTPS et adresse IP corrects
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(auth.originCheck);

const pub = path.join(__dirname, 'public');
app.get('/login', (req, res) => (auth.current(req) ? res.redirect('/') : res.sendFile(path.join(pub, 'login.html'))));
app.use('/api/auth', require('./routes/auth')());

app.use('/api/v1', auth.apiKeyAuth, require('./routes/api-v1')(runner));   // API publique : clé d'API
app.use('/api', auth.require);                   // tout le reste de l'API exige une connexion
app.get('/api/state', (req, res) => res.json({
  me: { username: req.user.username, role: req.user.role },
  wa: sessions.activeState(), sessions: sessions.list(), campaign: runner.view(), limits: runner.limitsInfo(),
  segments: db.segments.list(), total: db.contacts.total(), maxPerRun: MAX_PER_RUN,
}));
app.use('/api', require('./routes/contacts')());
app.use('/api', require('./routes/segments')());
app.use('/api', require('./routes/campaigns')(runner));
app.use('/api', require('./routes/sessions')(sessions, runner));
app.use('/api', require('./routes/users')());
app.use('/api', require('./routes/integrations')(runner));
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

app.get('/', auth.page, (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.use(express.static(pub, { index: false }));

// Arrêt propre (redéploiement) : la campagne en cours reste « en pause » et reprenable.
const shutdown = async () => {
  if (runner.isRunning()) { runner.pause(); await Promise.race([runner.settled(), new Promise(r => setTimeout(r, 7000))]); }
  await sessions.shutdown().catch(() => {});
  db.close(); process.exit(0);
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

app.listen(PORT, () => console.log(`Interface disponible sur http://localhost:${PORT}`));
