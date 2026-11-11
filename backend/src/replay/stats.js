/**
 * Player stats — derived purely from the recorded event stream. The recorder
 * runs this over a finished match's events when it seals the log (and over
 * already-recorded matches during the boot backfill), so the game logic
 * stays completely unaware of stats.
 *
 * Identity: player ids are per-join uuids, so stats are keyed by the
 * player's NAME (queries group case-insensitively) — the same handle typed
 * in the lobby across matches.
 *
 * Derived per player and match:
 * - role, captured, capturedReason        (room state broadcasts)
 * - survived, survivedPct                 (hider alive when the match ended;
 *                                          % of match time survived — from
 *                                          match start to the capture moment
 *                                          or the end)
 * - won                                   (their side won)
 * - captures, catchPctSum                 (hunters — via `capturedBy` in the
 *                                          state; endzone captures credit no
 *                                          one, the zone caught the hider.
 *                                          catchPctSum adds up every catch's
 *                                          "% of match time" so the average
 *                                          per catch is sum/captures)
 * - exposures                             (out-of-zone flag flips)
 * - distanceM / fixCount                  (haversine over consecutive GPS
 *                                          fixes — the log stores everyone's
 *                                          true positions)
 */

/** Approximate distance between two lat/lng points (haversine, meters). */
function haversineMeters(a, b) {
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

export function summarizePlayers(events) {
  const players = new Map()

  const entry = (id, data = {}) => {
    if (!players.has(id)) {
      players.set(id, {
        id,
        name: data.name ?? '?',
        role: data.role ?? 'hider',
        captured: false,
        capturedReason: null,
        capturedBy: null,
        capturedAt: null, // when the capture was reported (event timestamp)
        exposed: false,
        exposures: 0,
        lastFix: null,
        distanceM: 0,
        fixCount: 0,
      })
    }
    return players.get(id)
  }

  const list = events ?? []
  const t0 = new Date(list[0]?.at ?? Date.now()).getTime()
  let lastAt = t0

  for (const e of list) {
    const at = new Date(e.at ?? Date.now()).getTime()
    if (at > lastAt) lastAt = at
    switch (e.event) {
      case 'room:state_changed': {
        const rs = e.payload?.roomState
        if (!rs) break
        for (const p of Object.values(rs.players ?? {})) {
          if (!p?.id) continue
          const en = entry(p.id, p)
          if (p.name) en.name = p.name
          if (p.role) en.role = p.role
          if (p.captured && !en.captured) {
            en.captured = true
            en.capturedReason = p.capturedReason ?? null
            en.capturedBy = p.capturedBy ?? null
            en.capturedAt = at
          }
          if (p.isExposedLive && !en.exposed) en.exposures++
          en.exposed = !!p.isExposedLive
        }
        break
      }
      case 'map:hider_positions': {
        // Role-filtered lists — only the exposure flags are authoritative
        // here (coordinates are frozen reveal spots, never true positions).
        for (const h of e.payload ?? []) {
          if (!h?.id) continue
          const en = entry(h.id, h)
          if (h.isExposedLive && !en.exposed) en.exposures++
          en.exposed = !!h.isExposedLive
        }
        break
      }
      case 'player:location': {
        const p = e.payload ?? {}
        if (!p.playerId || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) break
        const en = entry(p.playerId)
        if (en.lastFix) en.distanceM += haversineMeters(en.lastFix, p)
        en.lastFix = { lat: p.lat, lng: p.lng }
        en.fixCount++
        break
      }
      default:
        break // ticks, reveals, proximity alerts … carry no roster state
    }
  }

  // The winner: the game:over payload (a stale-sealed match has none).
  let winner = null
  for (const e of list) {
    if (e.event === 'game:over') winner = e.payload?.winner ?? winner
    else if (e.event === 'room:state_changed' && e.payload?.roomState?.gameOver) {
      winner = e.payload.roomState.gameOver.winner ?? winner
    }
  }

  // Match time base for the percentages: first event → last event.
  const duration = Math.max(0, lastAt - t0)
  const pct = (at) => (duration > 0 ? Math.round(((at - t0) / duration) * 1000) / 10 : 0)

  return [...players.values()].map((p) => {
    const survivedPct = p.role === 'hider' ? pct(p.capturedAt ?? lastAt) : 0
    // Every catch credited to this hunter, as % of match time each.
    const catchPctSum =
      p.role === 'hunter'
        ? [...players.values()].reduce(
            (sum, o) => (o.captured && o.capturedBy === p.id ? sum + pct(o.capturedAt ?? lastAt) : sum),
            0,
          )
        : 0
    return {
      playerId: p.id,
      name: p.name,
      role: p.role,
      captured: p.captured,
      capturedReason: p.capturedReason,
      survived: p.role === 'hider' ? !p.captured : false,
      survivedPct,
      won: !!winner && (p.role === 'hunter' ? winner === 'hunters' : winner === 'hiders' && !p.captured),
      captures: [...players.values()].filter((o) => o.captured && o.capturedBy === p.id).length,
      catchPctSum: Math.round(catchPctSum * 10) / 10,
      exposures: p.exposures,
      distanceM: Math.round(p.distanceM * 10) / 10,
      fixCount: p.fixCount,
    }
  })
}
