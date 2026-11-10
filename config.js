require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { PORT = 3000, APP_USER = 'admin', APP_PASSWORD, DEFAULT_COUNTRY_CODE = '', MAX_PER_RUN = 300 } = process.env;
if (!APP_PASSWORD) { console.error('Définissez APP_PASSWORD dans le fichier .env'); process.exit(1); }

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

module.exports = {
  PORT, APP_USER, APP_PASSWORD, DEFAULT_COUNTRY_CODE, DATA,
  MAX_PER_RUN: +MAX_PER_RUN,
  STATUSES: ['yes', 'no', 'More information needed'],
};
