const express = require('express');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { handle, HttpError } = require('../http');

const csvCell = v => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);

module.exports = () => {
  const r = express.Router();

  r.get('/contacts', (req, res) => res.json(db.contacts.list(req.query)));
  r.post('/contacts', handle(req => {
    const x = db.contacts.upsert(req.body);
    if (x.error) throw new HttpError(400, x.error);
    return x;
  }));
  r.delete('/contacts/:id', handle(req => { db.contacts.remove(req.params.id); }));
  r.post('/contacts/delete', handle(req => ({ deleted: db.contacts.removeMany(Array.isArray(req.body.ids) ? req.body.ids : []) })));
  r.delete('/contacts', handle(() => { db.contacts.removeAll(); }));
  r.post('/reset-sent', handle(() => { db.contacts.resetSent(); }));

  r.post('/import', handle(req => {
    let rows;
    try { rows = parse(req.body.csv, { columns: h => h.map(x => x.trim().toLowerCase()), skip_empty_lines: true, bom: true, trim: true }); }
    catch (e) { throw new HttpError(400, 'CSV illisible : ' + e.message); }
    const results = db.contacts.importRows(rows.map(x => ({ email: x['email'], status: x['membership contribution'], phone: x['whatsapp number'] })));
    const out = { added: 0, updated: 0, invalid: [] };
    results.forEach((x, i) => {
      if (x.added) out.added++; else if (x.updated) out.updated++;
      else out.invalid.push({ line: i + 2, email: rows[i]['email'] || '', reason: x.error });
    });
    return out;
  }));

  r.get('/export.csv', (req, res) => {
    const lines = ['Email,Membership Contribution,WhatsApp Number', ...db.contacts.list().map(c => [c.email, c.status, c.phone].map(csvCell).join(','))];
    res.type('text/csv').attachment('contacts.csv').send(lines.join('\n'));
  });

  r.put('/templates', handle(req => { db.templates.set(req.body); }));
  return r;
};
