/**
 * Replay REST API — read side of the event log:
 * - `GET /api/matches`        → recorded matches (newest first)
 * - `GET /api/matches/:id`    → one match with its full event stream
 * - `GET /api/leaderboard`    → per-player stats aggregated over all matches
 * - `GET /api/players/:name`  → one player's aggregated stats + recent matches
 */
import { Router } from 'express'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createReplayRouter(store) {
  const router = Router()

  // No database configured: answer clearly instead of letting the SPA
  // fallback serve HTML to JSON clients.
  if (!store) {
    const disabled = (_req, res) =>
      res.status(503).json({ error: 'Replay-Aufzeichnung ist deaktiviert (keine Datenbank konfiguriert)' })
    router.get('/api/matches', disabled)
    router.get('/api/matches/:id', disabled)
    router.get('/api/leaderboard', disabled)
    router.get('/api/players/:name', disabled)
    return router
  }

  router.get('/api/leaderboard', async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
      res.json({ leaderboard: await store.leaderboard({ limit }) })
    } catch (err) {
      console.error('[replay] leaderboard failed:', err.message)
      res.status(500).json({ error: 'Bestenliste konnte nicht geladen werden' })
    }
  })

  router.get('/api/players/:name', async (req, res) => {
    try {
      const player = await store.playerStats(req.params.name)
      if (!player) return res.status(404).json({ error: 'Spieler nicht gefunden' })
      res.json(player)
    } catch (err) {
      console.error('[replay] player stats failed:', err.message)
      res.status(500).json({ error: 'Statistiken konnten nicht geladen werden' })
    }
  })

  router.get('/api/matches', async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
      res.json({ matches: await store.listMatches({ limit }) })
    } catch (err) {
      console.error('[replay] list failed:', err.message)
      res.status(500).json({ error: 'Replays konnten nicht geladen werden' })
    }
  })

  router.get('/api/matches/:id', async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Replay nicht gefunden' })
      const match = await store.getMatch(req.params.id)
      if (!match) return res.status(404).json({ error: 'Replay nicht gefunden' })
      const events = await store.getEvents(req.params.id)
      res.json({ match, events })
    } catch (err) {
      console.error('[replay] match fetch failed:', err.message)
      res.status(500).json({ error: 'Replay konnte nicht geladen werden' })
    }
  })

  return router
}
