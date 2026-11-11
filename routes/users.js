const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { handle, HttpError } = require('../http');

const ROLES = ['admin', 'member'];

module.exports = () => {
  const r = express.Router();
  r.use('/users', auth.requireRole('admin'));

  r.get('/users', (req, res) => res.json(db.users.list()));

  r.post('/users', handle(req => {
    const { username, password, role = 'member' } = req.body;
    auth.checkUsername(username); auth.checkPassword(password);
    if (!ROLES.includes(role)) throw new HttpError(400, 'Rôle invalide.');
    if (db.users.byName(username)) throw new HttpError(409, 'Cet identifiant existe déjà.');
    db.users.create({ username, passwordHash: auth.hashPassword(password), role });
  }));

  r.put('/users/:id', handle(req => {
    const u = db.users.byId(req.params.id);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable.');
    const { role, password } = req.body;
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw new HttpError(400, 'Rôle invalide.');
      if (u.role === 'admin' && role !== 'admin' && db.users.adminCount() <= 1) throw new HttpError(409, 'Il doit rester au moins un administrateur.');
      db.users.setRole(u.id, role);
    }
    if (password !== undefined) {
      auth.checkPassword(password);
      db.users.setPassword(u.id, auth.hashPassword(password));
      db.authSessions.removeForUser(u.id);
    }
  }));

  r.delete('/users/:id', handle(req => {
    const u = db.users.byId(req.params.id);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable.');
    if (u.id === req.user.id) throw new HttpError(409, 'Vous ne pouvez pas supprimer votre propre compte.');
    if (u.role === 'admin' && db.users.adminCount() <= 1) throw new HttpError(409, 'Il doit rester au moins un administrateur.');
    db.users.remove(u.id);
  }));

  return r;
};
