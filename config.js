// Fichiers et dossiers créés uniquement lisibles par l'utilisateur de l'application (la session WhatsApp donne accès au compte).
process.umask(0o077);
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { PORT = 3000, APP_USER = 'admin', APP_PASSWORD, DEFAULT_COUNTRY_CODE = '', MAX_PER_RUN = 300, COOKIE_SECURE } = process.env;

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
try { fs.chmodSync(DATA, 0o700); } catch (e) { console.warn('Permissions du dossier data non modifiées :', e.message); }

// Resserre les droits des fichiers de données déjà existants (base SQLite, copies d'anciens formats).
const tighten = () => {
  for (const f of ['app.db', 'app.db-wal', 'app.db-shm', 'sessions.json', 'db.json.migre']) {
    try { fs.chmodSync(path.join(DATA, f), 0o600); } catch { /* absent : rien à faire */ }
  }
};

module.exports = {
  PORT, APP_USER, APP_PASSWORD, DEFAULT_COUNTRY_CODE, DATA, tighten,
  COOKIE_SECURE,                       // '1' : toujours Secure · '0' : jamais (HTTP local) · vide : Secure en production
  MAX_PER_RUN: +MAX_PER_RUN,
  STATUSES: ['yes', 'no', 'More information needed'],
};
