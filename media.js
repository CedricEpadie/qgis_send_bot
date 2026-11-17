// Photos jointes : validation stricte (JPEG ou PNG), suppression des métadonnées (position GPS, appareil…), stockage sur disque.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { DATA } = require('./config');
const { HttpError } = require('./http');

const DIR = path.join(DATA, 'media');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
const MAX_BYTES = 5 * 1024 * 1024;               // limite de WhatsApp pour les images (JPEG, PNG)
const MAX_TOTAL = 300 * 1024 * 1024;             // espace maximum occupé par les photos
const CAPTION_MAX = 1024;                        // longueur maximale d'une légende de photo
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = msg => new HttpError(400, msg);

// JPEG : on garde l'image et le profil de couleur, on retire EXIF/XMP (APP1), IPTC (APP13), commentaires et segments constructeur.
function cleanJpeg(b) {
  const out = [b.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (i + 4 > b.length || b[i] !== 0xff) throw bad('Fichier JPEG invalide.');
    const m = b[i + 1], len = b.readUInt16BE(i + 2), end = i + 2 + len;
    if (len < 2 || end > b.length) throw bad('Fichier JPEG tronqué ou invalide.');
    const keep = !((m >= 0xe1 && m <= 0xef && !(m === 0xe2 && b.subarray(i + 4, i + 16).toString('latin1') === 'ICC_PROFILE\0') && m !== 0xee) || m === 0xfe);
    if (keep) out.push(b.subarray(i, end));
    if (m === 0xda) { out.push(b.subarray(end)); break; }          // SOS : le reste = données d'image jusqu'à la fin
    i = end;
  }
  const r = Buffer.concat(out);
  if (r[r.length - 2] !== 0xff || r[r.length - 1] !== 0xd9) throw bad('Fichier JPEG incomplet.');
  return r;
}
// PNG : on ne garde que les blocs nécessaires à l'affichage (pas de texte, de date ni d'EXIF).
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs']);
function cleanPng(b) {
  const out = [b.subarray(0, 8)];
  let i = 8, first = true, ended = false, idat = false;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8), end = i + 12 + len;
    if (end > b.length) throw bad('Fichier PNG tronqué ou invalide.');
    if (first && type !== 'IHDR') throw bad('Fichier PNG invalide.');
    first = false;
    if (type === 'IDAT') idat = true;
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !idat) throw bad('Fichier PNG incomplet.');
  return Buffer.concat(out);
}
function sanitize(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', buf: cleanJpeg(buf) };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png', buf: cleanPng(buf) };
  throw bad('Format non pris en charge : utilisez une photo JPEG ou PNG.');
}

function save({ data, createdBy }) {
  if (typeof data !== 'string' || !data) throw bad('Aucune image reçue.');
  const b64 = data.replace(/^data:[^;,]+;base64,/, '');
  if (b64.length > Math.ceil(MAX_BYTES * 4 / 3) + 16) throw new HttpError(413, 'Image trop lourde (5 Mo maximum).');
  const { mime, ext, buf } = sanitize(Buffer.from(b64, 'base64'));
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'Image trop lourde (5 Mo maximum).');
  if (db.media.totalSize() + buf.length > MAX_TOTAL) throw new HttpError(507, 'Espace de stockage des photos plein : supprimez d’anciennes campagnes.');
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(DIR, id), buf, { mode: 0o600 });
  db.media.add(id, mime, buf.length, `photo.${ext}`, createdBy);
  return { id, mime, size: buf.length };
}
function meta(id) { return UUID.test(String(id)) ? db.media.get(id) : undefined; }
function raw(id) {
  const m = meta(id);
  if (!m) throw new HttpError(404, 'Photo introuvable.');
  try { return { ...m, buf: fs.readFileSync(path.join(DIR, m.id)) }; } catch { throw new HttpError(404, 'Photo introuvable.'); }
}
// Format attendu par le fournisseur de messagerie.
function load(id) { const m = raw(id); return { mime: m.mime, filename: m.filename, data: m.buf.toString('base64') }; }
function discard(id) {
  if (!meta(id)) throw new HttpError(404, 'Photo introuvable.');
  if (db.media.isUsed(id)) throw new HttpError(409, 'Cette photo est utilisée par une campagne.');
  remove(id);
}
function remove(id) { db.media.remove(id); try { fs.unlinkSync(path.join(DIR, id)); } catch { /* déjà absent */ } }

// Nettoyage : photos abandonnées depuis plus de 24 h, et photos de campagnes terminées depuis plus de 60 jours.
function cleanup() {
  try {
    const day = 24 * 3600 * 1000, now = Date.now();
    for (const id of db.media.orphans(new Date(now - day).toISOString())) remove(id);
    for (const id of db.media.expired(new Date(now - 60 * day).toISOString())) remove(id);
    for (const f of fs.readdirSync(DIR)) if (UUID.test(f) && !db.media.get(f) && now - fs.statSync(path.join(DIR, f)).mtimeMs > day) fs.unlinkSync(path.join(DIR, f));
  } catch (e) { console.error('[photos] nettoyage :', e.message); }
}

module.exports = { save, meta, raw, load, discard, cleanup, CAPTION_MAX, MAX_BYTES };
