// API publique (clé d'API) : contacts, segments, message isolé, campagnes.
const express = require('express');
const db = require('../db');
const { handle, HttpError } = require('../http');

module.exports = runner => {
  const r = express.Router();
  r.get('/segments', (req, res) => res.json(db.segments.list().map(s => ({ name: s.name, contacts: s.count }))));
  r.get('/contacts', (req, res) => {
    const size = Math.min(200, Math.max(1, +req.query.size || 50)), page = Math.max(1, +req.query.page || 1);
    res.json({ ...db.contacts.list({ segment: req.query.segment, q: req.query.q, page, size }), page, size });
  });
  r.post('/contacts', handle(req => { const x = db.contacts.upsert(req.body); if (x.error) throw new HttpError(400, x.error); return x; }));
  r.post('/messages', handle(req => runner.sendOne({ phone: req.body.to, message: req.body.message, name: req.body.name })));
  r.post('/campaigns', handle(req => runner.start({ ...req.body, createdBy: req.user.username })));
  r.get('/campaigns/current', (req, res) => res.json(runner.view()));
  for (const a of ['pause', 'resume', 'stop']) r.post('/campaigns/current/' + a, handle(() => runner[a]()));
  return r;
};
