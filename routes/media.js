const express = require('express');
const media = require('../media');
const { handle } = require('../http');

const bigJson = express.json({ limit: '8mb' });          // image encodée en base64 (5 Mo maximum une fois décodée)

module.exports = () => {
  const r = express.Router();
  r.post('/media', bigJson, handle(req => media.save({ data: req.body.data, createdBy: req.user.username })));
  r.get('/media/:id', (req, res) => {
    try {
      const m = media.raw(req.params.id);
      res.set({ 'Content-Type': m.mime, 'Content-Disposition': `inline; filename="${m.filename}"`, 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(m.buf);
    } catch (e) { res.status(e.status || 404).json({ error: e.message }); }
  });
  r.delete('/media/:id', handle(req => { media.discard(req.params.id); }));
  return r;
};
