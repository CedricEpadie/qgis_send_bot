const express = require('express');
const db = require('../db');
const { handle } = require('../http');

module.exports = runner => {
  const r = express.Router();
  r.post('/send', handle(req => runner.start(req.body)));
  r.post('/campaign/pause', handle(() => runner.pause()));
  r.post('/campaign/resume', handle(() => runner.resume()));
  r.post('/campaign/stop', handle(() => runner.stop()));
  r.get('/campaigns', (req, res) => res.json(db.campaigns.list(30)));
  r.get('/logs', (req, res) => res.json(db.logs.recent(300)));
  return r;
};
