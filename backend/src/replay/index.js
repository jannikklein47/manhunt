/**
 * Match replay module — records every match as an event log in PostgreSQL
 * and serves it over a small REST API.
 *
 * Decoupled from the game server logic by construction: `rooms.js` has no
 * knowledge of it. The composition root (`index.js`) hands rooms a wrapped
 * io (outbound events are mirrored) and forwards accepted GPS fixes.
 *
 * - `createPgStore(url)`    — persistence (schema + queries)
 * - `createReplayService()` — the recorder (io wrapper + fix intake)
 * - `createReplayRouter()`  — GET /api/matches, GET /api/matches/:id
 *
 * With no DATABASE_URL configured the service is a passthrough: the game
 * server runs exactly as before.
 */
export { createPgStore } from './store.js'
export { createReplayService } from './service.js'
export { createReplayRouter } from './routes.js'
