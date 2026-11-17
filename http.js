class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// Enveloppe une action : renvoie son résultat en JSON. Les erreurs prévues (HttpError) gardent leur message ;
// toute autre erreur est journalisée côté serveur et renvoyée sous une forme générique (aucun détail interne exposé).
const handle = fn => async (req, res) => {
  try { res.json((await fn(req, res)) ?? { ok: true }); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error('[erreur]', req.method, req.originalUrl, e);
    res.status(500).json({ error: 'Erreur interne. Réessayez ou contactez un administrateur.' });
  }
};
module.exports = { HttpError, handle };
