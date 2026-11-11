# API WA Broadcast

Toutes les requêtes se font en HTTPS vers `https://VOTRE-DOMAINE/api/v1`, avec une clé créée dans
**Paramètres → Clés d’API** et envoyée dans l’en-tête :

```
Authorization: Bearer wab_xxxxxxxxxxxxxxxx
Content-Type: application/json
```

Limite : 120 requêtes par minute et par clé. Les envois respectent les mêmes protections que l’interface
(plage horaire, plafond quotidien, contacts désinscrits).

## Points d’accès

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/segments` | Liste des segments et nombre de contacts |
| GET | `/contacts?segment=&q=&page=&size=` | Contacts (pagination, 200 max par page) |
| POST | `/contacts` | Ajoute ou met à jour un contact : `{ "phone": "+237…", "name": "…", "email": "…", "segment": "Donateurs" }` (le segment est créé s’il n’existe pas) |
| POST | `/messages` | Envoie un message isolé : `{ "to": "+237…", "message": "Bonjour {name}", "name": "Marie" }` |
| POST | `/campaigns` | Lance une campagne : `{ "segment": "Donateurs", "message": "…", "skipContacted": true, "delayMin": 8, "delayMax": 20 }` |
| GET | `/campaigns/current` | État de la campagne en cours ou de la dernière |
| POST | `/campaigns/current/pause` · `/resume` · `/stop` | Pause, reprise, arrêt |

Variables de message : `{name}`, `{email}`, `{phone}`.

Codes d’erreur courants : `400` données invalides, `401` clé invalide, `409` contact désinscrit ou campagne déjà ouverte,
`422` numéro sans compte WhatsApp, `429` plafond/plage horaire ou trop de requêtes.

```bash
curl -X POST https://VOTRE-DOMAINE/api/v1/messages \
  -H "Authorization: Bearer $CLE" -H "Content-Type: application/json" \
  -d '{"to":"+237600000000","message":"Bonjour {name} !","name":"Marie"}'
```

## Webhooks

Créés dans **Paramètres → Webhooks**. Événements : `message.received`, `contact.opted_out`, `campaign.finished`
(plus `ping` pour le test). Corps de la requête :

```json
{ "id": "…", "event": "message.received", "createdAt": "2026-11-11T10:00:00.000Z",
  "data": { "phone": "237600000000", "name": "Marie", "segment": "Donateurs", "body": "STOP", "optOut": true } }
```

En-têtes : `X-Webhook-Event`, `X-Webhook-Id`, `X-Webhook-Signature: sha256=<HMAC>`. Vérification (Node.js) :

```js
const crypto = require('crypto');
const ok = signatureHeader === 'sha256=' +
  crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');   // rawBody = corps brut, avant tout JSON.parse
```

Votre serveur doit répondre en 2xx sous 8 secondes ; sinon 3 nouvelles tentatives sont faites (après 2 s, 10 s puis 60 s).
Ces tentatives sont gardées en mémoire : elles sont perdues si l’application redémarre.

Par sécurité, les adresses du réseau interne (127.x, 10.x, 192.168.x, etc.) sont refusées. Pour un récepteur installé sur le même
serveur, définissez `WEBHOOK_ALLOW_PRIVATE=1` dans le fichier `.env`.
