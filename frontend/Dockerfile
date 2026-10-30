# Manhunt SPA — build with Quasar, serve via nginx with TLS.
# The socket target is baked in at build time (Vite env): the backend runs on
# its own origin, e.g. https://batterysync.de:3001 (see docker-compose.yml).

# ---- stage 1: build the SPA ------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: the postinstall hook (`quasar prepare`) needs the full
# source tree — it runs as part of `quasar build` below instead.
RUN npm ci --ignore-scripts

COPY . .

ARG VITE_SOCKET_URL=https://batterysync.de:4000/backend
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL

RUN npx quasar build

# ---- stage 2: nginx with the mounted SSL certificates ----------------------
FROM nginx:alpine

ENV SSL_DIR=/etc/manhunt/ssl \
    SSL_CERT=fullchain.pem \
    SSL_KEY=privkey.pem \
    SERVER_NAME=batterysync.de

COPY --from=build /app/dist/spa /usr/share/nginx/html
# The official image renders /etc/nginx/templates/*.template with envsubst.
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 443
