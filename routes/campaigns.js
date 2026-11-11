const express = require('express');
const db = require('../db');
const { MAX_PER_RUN } = require('../config');
const { handle, HttpError } = require('../http');

module.exports = runner => {
  const r = express.Router();

  // Aperçu avant envoi : nombre de destinataires, déjà contactés, exemple de contact.
  r.post('/send/preview', handle(req => {
    const seg = db.segments.canonical(req.body.segment);
    if (!seg) throw new HttpError(400, 'Choisissez un segment.');
    const skip = req.body.skipContacted !== false;
    const eligible = db.contacts.eligible(seg, skip);
    return {
      segment: seg, eligible, willSend: Math.min(eligible, MAX_PER_RUN), maxPerRun: MAX_PER_RUN,
      total: db.contacts.eligible(seg, false), optedOut: db.contacts.optedOutCount(seg), sample: db.contacts.recipients(seg, skip, 1)[0] || null,
    };
  }));

  r.post('/send', handle(req => runner.start({ ...req.body, createdBy: req.user.username })));
  r.post('/campaign/pause', handle(() => runner.pause()));
  r.post('/campaign/resume', handle(() => runner.resume()));
  r.post('/campaign/stop', handle(() => runner.stop()));
  r.get('/campaigns', (req, res) => res.json(db.campaigns.list(30)));
  r.get('/logs', (req, res) => res.json(db.logs.recent(300)));
  return r;
};
