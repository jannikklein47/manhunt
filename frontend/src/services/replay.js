/**
 * Replay timeline builder — folds the recorded event stream into per-second
 * playback frames.
 *
 * The event log keeps every action verbatim (outgoing room broadcasts,
 * inbound GPS fixes). A replay viewer only needs the world STATE at a given
 * second, so this module reduces the stream exactly once on load:
 *
 * - `room:state_changed` — roster (names/roles/captured), status/phase,
 *   zone, countdowns
 * - `game:tick`          — zone center/radius, endgame preview, countdowns
 * - `player:location`    — the players' true fixes (the all-seeing replay:
 *   it shows where EVERYONE actually was, not what each role could see)
 * - `game:over`          — result
 *
 * Positions are carried forward between fixes, so every second of the match
 * has a complete frame.
 */

/**
 * @param {Array<{ seq: number, at: string, event: string, payload: object }>} events
 * @returns {{ startAt: number|null, seconds: number, frames: Array<object>, trails: Map<string, Array> }}
 */
export function buildTimeline(events) {
  const clean = (events ?? []).filter((e) => e?.event && e?.at)
  if (!clean.length) return { startAt: null, seconds: 0, frames: [], trails: new Map() }

  const t0 = Date.parse(clean[0].at)

  const state = {
    status: null,
    phase: null,
    winner: null,
    reason: null,
    zone: null, // { lat, lng, radius }
    endgameZone: null, // { lat, lng, radius } | null
    timeRemaining: null,
    endgameRemaining: null,
    hideRemaining: 0,
    players: new Map(), // id → { id, name, role, captured, capturedSec, isExposedLive, exposedSec, connected, pos }
    revealSecs: new Set(), // seconds on which `hiders:revealed` fired
  }

  const rosterEntry = (id, data = {}) => {
    if (!state.players.has(id)) {
      state.players.set(id, {
        id,
        name: data.name ?? '?',
        role: data.role ?? 'hider',
        captured: false,
        capturedSec: null, // second the capture was reported
        isExposedLive: false,
        exposedSec: null, // second the hider (first) left the zone
        connected: true,
        pos: null,
      })
    }
    return state.players.get(id)
  }

  function apply(e, sec) {
    switch (e.event) {
      case 'room:state_changed': {
        const rs = e.payload?.roomState
        if (!rs) break
        state.status = rs.status ?? state.status
        state.phase = rs.phase ?? state.phase
        if (rs.gameOver) {
          state.winner = rs.gameOver.winner
          state.reason = rs.gameOver.reason
        }
        if (rs.zoneCenter) {
          state.zone = {
            lat: rs.zoneCenter.lat,
            lng: rs.zoneCenter.lng,
            radius: rs.currentZoneRadius ?? state.zone?.radius ?? 0,
          }
        }
        state.endgameZone = rs.endgameZone ? { ...rs.endgameZone } : null
        if (rs.timeRemaining != null) state.timeRemaining = rs.timeRemaining
        state.endgameRemaining = rs.endgameRemaining ?? state.endgameRemaining
        state.hideRemaining = rs.hideRemaining ?? state.hideRemaining
        for (const p of Object.values(rs.players ?? {})) {
          const entry = rosterEntry(p.id, p)
          // Transition seconds — the viewer pulses on these events.
          if (p.captured && !entry.captured) entry.capturedSec = sec
          if (p.isExposedLive && !entry.isExposedLive) entry.exposedSec = sec
          Object.assign(entry, {
            name: p.name,
            role: p.role,
            captured: !!p.captured,
            connected: !!p.connected,
            isExposedLive: !!p.isExposedLive,
          })
        }
        break
      }
      case 'hiders:revealed': {
        state.revealSecs.add(sec)
        break
      }
      case 'map:hider_positions': {
        // These lists carry the isExposedLive flags — the only record of
        // exposure flips between state broadcasts. Their coordinates are
        // role-filtered (frozen reveal spots), so only the flags are
        // applied — TRUE positions come from the player:location fixes.
        for (const h of e.payload ?? []) {
          if (!h?.id) continue
          const entry = rosterEntry(h.id, h)
          if (h.isExposedLive && !entry.isExposedLive) entry.exposedSec = sec
          entry.isExposedLive = !!h.isExposedLive
        }
        break
      }
      case 'game:tick': {
        const p = e.payload ?? {}
        if (p.zoneCenter) {
          state.zone = {
            lat: p.zoneCenter.lat,
            lng: p.zoneCenter.lng,
            radius: p.currentZoneRadius ?? 0,
          }
        }
        state.endgameZone = p.endgameZone ? { ...p.endgameZone } : null
        if (p.timeRemaining != null) state.timeRemaining = p.timeRemaining
        state.endgameRemaining = p.endgameRemaining ?? state.endgameRemaining
        state.phase = p.phase ?? state.phase
        state.hideRemaining = p.hideRemaining ?? state.hideRemaining
        break
      }
      case 'player:location': {
        const p = e.payload ?? {}
        if (p.playerId && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
          rosterEntry(p.playerId).pos = { lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null }
        }
        break
      }
      case 'game:over': {
        state.status = 'ended'
        state.winner = e.payload?.winner ?? state.winner
        state.reason = e.payload?.reason ?? state.reason
        break
      }
      default:
        break // proximity alerts, reveals … need no frame state
    }
  }

  const snapshot = (sec) => ({
    sec,
    status: state.status,
    phase: state.phase,
    winner: state.winner,
    reason: state.reason,
    zone: state.zone,
    endgameZone: state.endgameZone,
    timeRemaining: state.timeRemaining,
    endgameRemaining: state.endgameRemaining,
    hideRemaining: state.hideRemaining,
    reveal: state.revealSecs.has(sec), // a hider reveal happened THIS second
    players: [...state.players.values()].map((p) => ({ ...p })), // pos shared by reference (replaced, never mutated)
  })

  // Trails: each player's true fix history in seconds (for the track lines).
  const trails = new Map()

  const frames = []
  let nextSecond = 0
  for (const e of clean) {
    const sec = Math.max(0, Math.floor((Date.parse(e.at) - t0) / 1000))
    // Frames for the seconds BEFORE this event keep the pre-event state —
    // an event must only surface in the frame OF its own second (pausing
    // there is what pulses on).
    while (nextSecond < sec) frames.push(snapshot(nextSecond++))
    apply(e, sec)
    if (e.event === 'player:location' && Number.isFinite(e.payload?.lat)) {
      if (!trails.has(e.payload.playerId)) trails.set(e.payload.playerId, [])
      trails.get(e.payload.playerId).push({ sec, lat: e.payload.lat, lng: e.payload.lng })
    }
  }
  frames.push(snapshot(nextSecond)) // the end state (result banner)

  return { startAt: t0, seconds: frames.length - 1, frames, trails }
}

/** m:ss formatting for countdowns and the playback clock. */
export function formatClock(totalSeconds) {
  const t = Math.max(0, Math.round(totalSeconds ?? 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/** Date + time of a match start (ISO string or Date) in the user's locale. */
export function formatMatchDate(iso) {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return '–'
  return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}
