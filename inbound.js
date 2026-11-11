// Messages reçus : historique des réponses, désinscription automatique (STOP…), webhooks.
const db = require('./db');
const limits = require('./limits');
const webhooks = require('./webhooks');

module.exports = (sessions, provider) => {
  sessions.on('message', async m => {
    try {
      const phone = String(m.phone).replace(/\D/g, '');
      if (!phone) return;
      const contact = db.contacts.byPhone(phone), s = db.settings.get();
      const body = m.body || (m.type && m.type !== 'chat' ? `[${m.type}]` : '');
      const optout = limits.isOptOut(body, s.optoutKeywords);
      db.replies.add({ sessionId: m.sessionId, phone, contactId: contact && contact.id, body, optout });
      const who = { phone, name: contact ? contact.name : null, segment: contact ? contact.segment : null };
      webhooks.emit('message.received', { ...who, body, sessionId: m.sessionId, optOut: optout });
      if (optout && contact && !contact.optedOut) {
        db.contacts.setOptedOut(contact.id, true);
        webhooks.emit('contact.opted_out', who);
        if (s.optoutReply && provider.isReady()) {
          try { const chat = await provider.resolve(phone); if (chat) await provider.send(chat, s.optoutReply); } catch (e) { console.error('[désinscription] réponse non envoyée :', e.message); }
        }
      }
    } catch (e) { console.error('[message entrant]', e); }
  });
};
