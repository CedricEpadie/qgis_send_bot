# WA Broadcast

Envoi de messages WhatsApp par groupe (Membership Contribution : yes / no / More information needed).

## Installation sur le VPS (Ubuntu 22.04/24.04)

```bash
# 1. Node 20 + dépendances de Chromium
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git libgbm1 libasound2t64 libatk-bridge2.0-0 libgtk-3-0 libnss3 libxss1 libxshmfence1 fonts-liberation
# (sur Ubuntu 22.04 remplacez libasound2t64 par libasound2)

# 2. Application
cd wa-broadcast && npm install
cp .env.example .env && nano .env      # changez APP_PASSWORD

# 3. Lancement permanent
sudo npm i -g pm2
pm2 start server.js --name wa-broadcast
pm2 save && pm2 startup
```

Ouvrez `http://IP_DU_VPS:3000` (identifiants du `.env`), scannez le QR code, importez vos contacts, envoyez.

## HTTPS (fortement recommandé)
Mettez Nginx + Let's Encrypt devant le port 3000, ou n'exposez pas le port et utilisez un tunnel SSH :
`ssh -L 3000:localhost:3000 user@IP_DU_VPS` puis http://localhost:3000.

## Sauvegarde
Le dossier `data/` contient la session WhatsApp (pas de nouveau QR au redémarrage) et la base de contacts.
