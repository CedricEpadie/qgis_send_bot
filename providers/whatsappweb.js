// Fournisseur de messagerie « WhatsApp Web » (whatsapp-web.js). Une autre implémentation (API officielle,
// Baileys, SMS…) peut être branchée en exposant les mêmes méthodes : isReady, resolve, send.
const { MessageMedia } = require('whatsapp-web.js');

module.exports = sessions => ({
  name: 'whatsapp-web',
  isReady: () => !!sessions.readyClient(),
  // Renvoie l'identifiant de discussion du numéro, ou null s'il n'a pas de compte.
  async resolve(phone) {
    const w = await sessions.readyClient().getNumberId(phone);
    return w ? w._serialized : null;
  },
  // media : { mime, data (base64), filename } — le texte devient alors la légende de la photo.
  async send(chatId, text, media) {
    const c = sessions.readyClient();
    if (media) await c.sendMessage(chatId, new MessageMedia(media.mime, media.data, media.filename), { caption: text });
    else await c.sendMessage(chatId, text);
  },
});
