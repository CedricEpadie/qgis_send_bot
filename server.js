const express = require('express');
const basicAuth = require('express-basic-auth');
const fs = require('fs');
const path = require('path');
const { PORT, APP_USER, APP_PASSWORD, DATA, MAX_PER_RUN } = require('./config');
const db = require('./db');
const SessionManager = require('./sessions');
const CampaignRunner = require('./campaigns');

const sessions = new SessionManager({ dataDir: DATA });
const runner = new CampaignRunner(sessions);
runner.init();
sessions.init().catch(e => console.error('Initialisation des sessions :', e));

const app = express();
app.use(basicAuth({ users: { [APP_USER]: APP_PASSWORD }, challenge: true }));
app.use(express.json({ limit: '10mb' }));

const pubDir = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(pubDir, { index: 'index.html' }));
app.get('/', (req, res) => res.sendFile(path.join(pubDir, 'index.html'), err => {
  if (err) res.status(500).send('index.html introuvable : placez-le dans le dossier public/');
}));

app.get('/api/state', (req, res) => res.json({
  wa: sessions.activeState(), sessions: sessions.list(), campaign: runner.view(),
  counts: db.contacts.counts(), total: db.contacts.total(), templates: db.templates.all(), maxPerRun: MAX_PER_RUN,
}));
app.use('/api', require('./routes/contacts')());
app.use('/api', require('./routes/campaigns')(runner));
app.use('/api', require('./routes/sessions')(sessions, runner));

// Arrêt propre (redéploiement) : la campagne en cours reste « en pause » et reprenable.
const shutdown = async () => {
  if (runner.isRunning()) { runner.pause(); await Promise.race([runner.settled(), new Promise(r => setTimeout(r, 7000))]); }
  await sessions.shutdown().catch(() => {});
  db.close(); process.exit(0);
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

app.listen(PORT, () => console.log(`Interface disponible sur http://localhost:${PORT}`));
