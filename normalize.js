const { DEFAULT_COUNTRY_CODE } = require('./config');

const normStatus = s => {
  const v = String(s || '').trim().toLowerCase();
  if (['yes', 'oui', 'y'].includes(v)) return 'yes';
  if (['no', 'non', 'n'].includes(v)) return 'no';
  if (v.startsWith('more')) return 'More information needed';
  return null;
};

const normPhone = raw => {
  let s = String(raw || '').trim();
  const intl = s.startsWith('+') || s.startsWith('00');
  s = s.replace(/\D/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  if (!intl && DEFAULT_COUNTRY_CODE && !s.startsWith(DEFAULT_COUNTRY_CODE)) s = DEFAULT_COUNTRY_CODE + s.replace(/^0+/, '');
  return /^\d{8,15}$/.test(s) ? s : null;
};

const render = (t, c) => t.replace(/\{name\}/g, c.name || '').replace(/\{email\}/g, c.email || '').replace(/\{phone\}/g, c.phone);

module.exports = { normStatus, normPhone, render };
