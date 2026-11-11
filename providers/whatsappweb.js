// Fournisseur de messagerie « WhatsApp Web » (whatsapp-web.js). Une autre implémentation (API officielle,
// Baileys, SMS…) peut être branchée en exposant les mêmes méthodes : isReady, resolve, send.
module.exports = sessions => ({
  name: 'whatsapp-web',
  isReady: () => !!sessions.readyClient(),
  // Renvoie l'identifiant de discussion du numéro, ou null s'il n'a pas de compte.
  async resolve(phone) {
    const w = await sessions.readyClient().getNumberId(phone);
    return w ? w._serialized : null;
  },
  async send(chatId, text) { await sessions.readyClient().sendMessage(chatId, text); },
});
