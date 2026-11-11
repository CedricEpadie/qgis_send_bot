class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// Enveloppe une action : renvoie son résultat en JSON, ou { error } avec le bon code HTTP.
const handle = fn => async (req, res) => {
  try { res.json((await fn(req, res)) ?? { ok: true }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};
module.exports = { HttpError, handle };
