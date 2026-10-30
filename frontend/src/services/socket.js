/**
 * Socket.io singleton.
 *
 * - Dev: the Quasar dev server proxies `/socket.io` to the game server (see
 *   quasar.config.js) — base = window.location.origin, path = /socket.io.
 * - Local prod: the game server serves this SPA itself — same origin.
 * - Docker deployment: nginx serves the SPA on the shared origin and proxies
 *   `/backend/` to the game server. `VITE_SOCKET_URL` =
 *   `https://batterysync.de:4000/backend` — the manager connects to the bare
 *   origin (the URL path would be a socket.io *namespace*!) and the
 *   engine.io endpoint rides on `<base>/socket.io` via the `path` option.
 */
import { io } from 'socket.io-client'

const SOCKET_BASE = import.meta.env.VITE_SOCKET_URL || window.location.origin

const { socketUrl, socketPath } = (() => {
  try {
    const url = new URL(SOCKET_BASE, window.location.origin)
    const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return { socketUrl: url.origin, socketPath: `${prefix}/socket.io` }
  } catch {
    return { socketUrl: SOCKET_BASE, socketPath: '/socket.io' }
  }
})()

export const socket = io(socketUrl, {
  path: socketPath,
  autoConnect: true,
})
