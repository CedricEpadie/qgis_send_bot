FROM node:20-bookworm-slim

# Chromium système (requis par whatsapp-web.js / Puppeteer) + polices
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

# On utilise le Chromium système : pas de téléchargement par Puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# package-lock.json est ignoré par le .gitignore du projet -> npm install
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# Dossier data = session WhatsApp + base de contacts (monté en volume)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3010

# Supprime d'éventuels verrous Chromium laissés par un arrêt brutal, puis démarre
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "find /app/data/session -name 'Singleton*' -delete 2>/dev/null; exec node server.js"]