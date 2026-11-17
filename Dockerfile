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

# Versions figées par package-lock.json (installation reproductible).
# better-sqlite3 télécharge un binaire précompilé ; à défaut, on installe les outils de compilation.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 || (apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
     && npm ci --omit=dev \
     && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*) \
 && npm cache clean --force

COPY . .

# Dossier data = sessions WhatsApp + base SQLite (monté en volume)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3010

# « healthy » tant que l'application répond et que la base est accessible
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Supprime d'éventuels verrous Chromium laissés par un arrêt brutal, puis démarre
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "find /app/data/session -name 'Singleton*' -delete 2>/dev/null; exec node server.js"]
