# Manhunt game server — Express + Socket.io (HTTPS-capable).
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only (lockfile-backed).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    PORT=3001 \
    SSL_DIR=/etc/manhunt/ssl \
    SSL_CERT=fullchain.pem \
    SSL_KEY=privkey.pem

EXPOSE 3001

CMD ["node", "src/index.js"]
