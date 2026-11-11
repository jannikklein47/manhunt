/**
 * REST client for the replay API. Mirrors the URL logic of services/socket.js:
 * the API rides on the same origin — in the Docker deployment under the nginx
 * `/backend` prefix (derived from VITE_SOCKET_URL), in dev the Quasar dev
 * server proxies `/api` to the game server (see quasar.config.js).
 */
const SOCKET_BASE = import.meta.env.VITE_SOCKET_URL || window.location.origin

const API_BASE = (() => {
  try {
    const url = new URL(SOCKET_BASE, window.location.origin)
    const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return `${url.origin}${prefix}`
  } catch {
    return ''
  }
})()

async function get(path) {
  const res = await fetch(`${API_BASE}${path}`)
  // A 200 with HTML here means the request never reached the game server —
  // e.g. a dev server started before the /api proxy existed, or a stale
  // deployment. Answer with a clear message instead of a JSON parse crash.
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok || !type.includes('application/json')) {
    let message = `HTTP ${res.status}`
    try {
      message = (await res.json())?.error || message
    } catch {
      if (type.includes('text/html')) {
        message = 'Replay-API nicht erreichbar — läuft der Game-Server?'
      }
    }
    throw new Error(message)
  }
  return res.json()
}

export const api = {
  /** All recorded matches, newest first. */
  matches: () => get('/api/matches').then((b) => b.matches ?? []),
  /** One match with its full event stream: { match, events }. */
  match: (id) => get(`/api/matches/${id}`),
}
