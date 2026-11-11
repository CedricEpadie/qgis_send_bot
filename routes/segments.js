const express = require('express');
const db = require('../db');
const { handle } = require('../http');

module.exports = () => {
  const r = express.Router();
  r.get('/segments', (req, res) => res.json(db.segments.list()));
  r.post('/segments', handle(req => ({ name: db.segments.create(req.body.name, req.body.template || '') })));
  r.put('/segments/:name', handle(req => {
    let name = req.params.name;
    if (req.body.template !== undefined) db.segments.setTemplate(name, req.body.template);
    if (req.body.name !== undefined && req.body.name !== name) name = db.segments.rename(name, req.body.name);
    return { name };
  }));
  r.delete('/segments/:name', handle(req => { db.segments.remove(req.params.name, req.query.moveTo); }));
  return r;
};
