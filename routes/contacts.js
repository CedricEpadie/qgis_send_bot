const express = require('express');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { handle, HttpError } = require('../http');

const csvCell = v => (/[",\n;]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);

// Lecture d'un CSV : séparateur détecté (, ; tabulation), première ligne = en-têtes.
function readCsv(text) {
  let rows;
  try { rows = parse(String(text || ''), { columns: false, skip_empty_lines: true, bom: true, trim: true, delimiter: [',', ';', '\t'], relax_column_count: true }); }
  catch (e) { throw new HttpError(400, 'CSV illisible : ' + e.message); }
  if (rows.length < 2) throw new HttpError(400, 'Le fichier doit contenir une ligne d’en-têtes et au moins un contact.');
  return { headers: rows[0].map(h => h.trim()), data: rows.slice(1) };
}
// Proposition automatique de correspondance colonnes -> champs (indices de colonnes).
const GUESS = { phone: /whats|phone|t[ée]l|mobile|num/i, email: /e-?mail|courriel|mail/i, name: /^(nom|name|pr[ée]nom|full)/i, segment: /segment|group|cat[ée]g|contribution|status|statut|tag/i };
function guess(headers) {
  const used = new Set(), out = {};
  for (const [field, re] of Object.entries(GUESS)) {
    const i = headers.findIndex((h, k) => !used.has(k) && re.test(h));
    out[field] = i >= 0 ? i : null;
    if (i >= 0) used.add(i);
  }
  return out;
}

module.exports = () => {
  const r = express.Router();

  r.get('/contacts', (req, res) => {
    const size = Math.min(200, Math.max(1, +req.query.size || 25)), page = Math.max(1, +req.query.page || 1);
    const { items, total } = db.contacts.list({ segment: req.query.segment, q: req.query.q, page, size });
    res.json({ items, total, page, size });
  });
  r.post('/contacts', handle(req => {
    const x = db.contacts.upsert(req.body);
    if (x.error) throw new HttpError(400, x.error);
    return x;
  }));
  r.put('/contacts/:id', handle(req => { db.contacts.update(req.params.id, req.body); }));
  r.delete('/contacts/:id', handle(req => { db.contacts.remove(req.params.id); }));
  r.post('/contacts/delete', handle(req => ({ deleted: db.contacts.removeMany(Array.isArray(req.body.ids) ? req.body.ids : []) })));
  r.delete('/contacts', handle(() => { db.contacts.removeAll(); }));
  r.post('/reset-sent', handle(() => { db.contacts.resetSent(); }));

  r.post('/import/preview', handle(req => {
    const { headers, data } = readCsv(req.body.csv);
    return { headers, sample: data.slice(0, 5), total: data.length, mapping: guess(headers) };
  }));

  r.post('/import', handle(req => {
    const { headers, data } = readCsv(req.body.csv);
    const m = req.body.mapping || {}, col = k => (Number.isInteger(m[k]) && m[k] >= 0 && m[k] < headers.length ? m[k] : null);
    if (col('phone') === null) throw new HttpError(400, 'Indiquez la colonne qui contient les numéros de téléphone.');
    const def = String(req.body.defaultSegment || '').trim();
    if (col('segment') === null && !def) throw new HttpError(400, 'Choisissez une colonne de segment ou un segment par défaut.');
    const before = new Set(db.segments.list().map(s => s.name));
    const get = (row, k) => (col(k) === null ? '' : row[col(k)] || '');
    const results = db.contacts.importRows(data.map(row => ({
      phone: get(row, 'phone'), name: get(row, 'name'), email: get(row, 'email'), segment: get(row, 'segment') || def,
    })));
    const out = { added: 0, updated: 0, invalidCount: 0, invalid: [], createdSegments: db.segments.list().map(s => s.name).filter(n => !before.has(n)) };
    results.forEach((x, i) => {
      if (x.added) out.added++; else if (x.updated) out.updated++;
      else { out.invalidCount++; if (out.invalid.length < 50) out.invalid.push({ line: i + 2, label: get(data[i], 'name') || get(data[i], 'email') || get(data[i], 'phone'), reason: x.error }); }
    });
    return out;
  }));

  r.get('/export.csv', (req, res) => {
    const lines = ['Name,Email,Segment,WhatsApp Number', ...db.contacts.all().map(c => [c.name, c.email, c.segment, c.phone].map(csvCell).join(','))];
    res.type('text/csv').attachment('contacts.csv').send('\ufeff' + lines.join('\n'));
  });

  return r;
};
