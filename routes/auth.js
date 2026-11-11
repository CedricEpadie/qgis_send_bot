const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { handle, HttpError } = require('../http');

module.exports = () => {
  const r = express.Router();

  r.post('/login', handle((req, res) => {
    const { token, user } = auth.login(req.body.username, req.body.password, req.ip);
    auth.setCookie(req, res, token);
    return { username: user.username, role: user.role };
  }));

  r.post('/logout', handle((req, res) => {
    const t = auth.readCookie(req, 'sid');
    if (t) db.authSessions.remove(auth.sha(t));
    auth.setCookie(req, res, '', 0);
  }));

  r.get('/me', auth.require, (req, res) => res.json({ username: req.user.username, role: req.user.role }));

  r.post('/password', auth.require, handle((req, res) => {
    const u = db.users.byId(req.user.id);
    if (!auth.verifyPassword(String(req.body.current || ''), u.password_hash)) throw new HttpError(400, 'Mot de passe actuel incorrect.');
    auth.checkPassword(req.body.next);
    db.users.setPassword(u.id, auth.hashPassword(req.body.next));
    db.authSessions.removeForUser(u.id);                     // déconnecte les autres appareils
    auth.setCookie(req, res, auth.createSession(u.id));
  }));

  return r;
};
