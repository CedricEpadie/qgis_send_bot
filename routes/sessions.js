const express = require('express');
const auth = require('../auth');
const { handle, HttpError } = require('../http');

module.exports = (sessions, runner) => {
  const r = express.Router();
  // Lecture pour tous ; gestion des numéros réservée aux administrateurs.
  r.use('/sessions', (req, res, next) => (req.method === 'GET' ? next() : auth.requireRole('admin')(req, res, next)));
  // Changer de numéro pendant qu'un envoi tourne casserait la campagne : on exige d'abord la pause ou l'arrêt.
  const guarded = fn => handle(req => {
    if (runner.isRunning()) throw new HttpError(409, 'Un envoi est en cours : mettez-le en pause ou arrêtez-le avant de modifier les sessions.');
    return fn(req);
  });
  r.get('/sessions', (req, res) => res.json(sessions.list()));
  r.post('/sessions', guarded(req => sessions.add(req.body.name)));
  r.put('/sessions/:id', handle(req => sessions.rename(req.params.id, req.body.name)));
  r.post('/sessions/:id/activate', guarded(req => sessions.activate(req.params.id)));
  r.post('/sessions/:id/restart', guarded(req => sessions.restart(req.params.id)));
  r.post('/sessions/:id/reset', guarded(req => sessions.reset(req.params.id)));
  r.delete('/sessions/:id', guarded(req => sessions.remove(req.params.id)));
  return r;
};
