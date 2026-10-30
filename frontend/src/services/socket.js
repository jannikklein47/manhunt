/**
 * Socket.io singleton. In dev the Quasar dev server proxies `/socket.io`
 * to the game server (see quasar.config.js), in production the game server
 * serves this SPA itself — so the same origin works for both.
 */
import { io } from 'socket.io-client'

export const socket = io(import.meta.env.VITE_SOCKET_URL || window.location.origin, {
  autoConnect: true,
})
