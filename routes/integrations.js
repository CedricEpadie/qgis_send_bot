// Réglages (protections, désinscription), clés d'API et webhooks.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const webhooks = require('../webhooks');
const { handle, HttpError } = require('../http');

module.exports = runner => {
  const r = express.Router();
  const admin = auth.requireRole('admin');

  r.get('/settings', (req, res) => res.json({ settings: db.settings.get(), limits: runner.limitsInfo() }));
  r.put('/settings', admin, handle(req => ({ settings: db.settings.set(req.body) })));

  r.get('/replies', (req, res) => res.json(db.replies.recent(200)));

  r.get('/keys', admin, (req, res) => res.json(db.apiKeys.list()));
  r.post('/keys', admin, handle(req => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Donnez un nom à la clé.');
    const k = auth.newApiKey();
    db.apiKeys.create(name, k.prefix, k.hash, req.user.username);
    return { key: k.key };                                   // affichée une seule fois : seule l'empreinte est conservée
  }));
  r.delete('/keys/:id', admin, handle(req => { db.apiKeys.remove(req.params.id); }));

  r.get('/webhooks', admin, (req, res) => res.json({ items: db.webhooks.list(), events: webhooks.EVENTS }));
  r.post('/webhooks', admin, handle(req => webhooks.create(req.body.url, req.body.events)));
  r.post('/webhooks/:id/test', admin, handle(req => webhooks.ping(req.params.id)));
  r.put('/webhooks/:id', admin, handle(req => { db.webhooks.setActive(req.params.id, !!req.body.active); }));
  r.delete('/webhooks/:id', admin, handle(req => { db.webhooks.remove(req.params.id); }));
  return r;
};
