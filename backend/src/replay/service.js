/**
 * Replay recorder — a passively OBSERVING module, fully decoupled from the
 * game logic: `rooms.js` does not know it exists. It hooks into the two
 * places the composition root (`index.js`) already owns:
 *
 * 1. `wrapIo(io)` — rooms only ever talk through `io.to(target).emit(...)`.
 *    The wrapped io forwards everything verbatim AND mirrors it ALL into the
 *    event log — room-scoped events under the lobby code, socket-scoped
 *    events (per-hider alerts, role-filtered position lists, …) via
 *    `resolveSocketRoom`. Nothing is filtered by "usefulness": if an action
 *    was emitted, it is in the log, even if no viewer needs it today.
 *    Direct `socket.emit` resyncs bypass io by design — they carry no
 *    information the room broadcasts don't already contain.
 *
 * 2. `recordFix(...)` — inbound GPS fixes, the one action that never rides
 *    an outbound broadcast (those are role-filtered).
 *
 * Match lifecycle is detected FROM the stream itself: the first
 * `room:state_changed` with status "active" opens a match (id, code, date,
 * settings + roster snapshot), `game:over` closes it. No game-state polls,
 * no callbacks into rooms — if an event happened, it is in the log.
 *
 * Everything is fault-tolerant by contract: a dead database must never
 * break a game. Writes are buffered in memory and flushed in batches on a
 * background interval, per recording strictly ordered, with retry.
 */
import { randomUUID } from 'node:crypto'
import { summarizePlayers } from './stats.js'

const FLUSH_INTERVAL_MS = 1000
/** Flush immediately when the buffer passes this size. */
const FLUSH_THRESHOLD = 200
/** Buffer cap while the DB is down — beyond it, oldest events are dropped. */
const BUFFER_MAX = 100_000
/** A recording with no events for this long is considered abandoned. */
const STALE_MS = 15 * 60 * 1000

export function createReplayService({ store, resolveSocketRoom } = {}) {
  if (!store) {
    // Replay disabled: a pure passthrough — the game server behaves exactly
    // as before.
    return {
      enabled: false,
      wrapIo: (io) => io,
      recordFix: () => {},
      flushAll: async () => {},
    }
  }

  /** lobby code → recording. */
  const recordings = new Map()

  function createRecording(lobbyCode, roomState) {
    const rec = {
      matchId: randomUUID(), // generated app-side: no insert/roundtrip ordering worries
      lobbyCode,
      startedAt: new Date(),
      settings: roomState?.settings ?? {},
      players: Object.values(roomState?.players ?? {}).map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        isHost: p.id === roomState?.hostId,
      })),
      seq: 0,
      buffer: [],
      over: null, // game:over payload once seen
      rowQueued: false,
      /** Last recorded socket-scoped payload per event — fan-out dedupe. */
      lastScoped: new Map(),
      /** Per-recording write chain — batches hit the DB strictly in order. */
      queue: Promise.resolve(),
      lastEventAt: Date.now(),
    }
    recordings.set(lobbyCode, rec)
    return rec
  }

  function observe(rec, event, payload) {
    rec.seq += 1
    rec.lastEventAt = Date.now()
    rec.buffer.push({ seq: rec.seq, at: new Date(), event, payload: payload ?? null })
    if (rec.buffer.length > BUFFER_MAX) rec.buffer.splice(0, rec.buffer.length - BUFFER_MAX)

    if (event === 'game:over') {
      rec.over = payload ?? {}
      close(rec)
    } else if (rec.buffer.length >= FLUSH_THRESHOLD) {
      enqueueFlush(rec)
    }
  }

  function recordOutbound(target, event, payload) {
    try {
      let rec = recordings.get(target)
      if (!rec) {
        // First active state broadcast of a (re)started match opens it.
        if (event === 'room:state_changed' && payload?.roomState?.status === 'active') {
          rec = createRecording(target, payload.roomState)
        } else {
          // Socket-scoped: log EVERY event (future-proof — storage is cheap,
          // a missing action is gone forever), attributed to the player's
          // room. Role fan-out emits the SAME payload to N sockets —
          // identical consecutive copies collapse into one row.
          const code = resolveSocketRoom?.(target)
          rec = code ? recordings.get(code) : undefined
          if (!rec) return
          const json = JSON.stringify(payload ?? null)
          if (rec.lastScoped.get(event) === json) return
          rec.lastScoped.set(event, json)
        }
      }
      if (rec) {
        if (!rec.rowQueued) {
          rec.rowQueued = true
          enqueueRow(rec)
        }
        observe(rec, event, payload)
      }
    } catch (err) {
      console.error('[replay] recording failed:', err.message)
    }
  }

  /** Wrap an io for Room consumption: same surface, observed emits. */
  function wrapIo(io) {
    return {
      to(target) {
        const inner = io.to(target)
        return {
          emit: (event, payload) => {
            recordOutbound(target, event, payload)
            inner.emit(event, payload)
          },
        }
      },
    }
  }

  /** Inbound action: an accepted GPS fix of a player in a recorded room. */
  function recordFix(lobbyCode, playerId, fix) {
    try {
      const rec = recordings.get(lobbyCode)
      if (!rec) return // lobby / already ended — not part of the match
      observe(rec, 'player:location', {
        playerId,
        lat: fix?.lat,
        lng: fix?.lng,
        accuracy: fix?.accuracy ?? null,
        at: Date.now(),
      })
    } catch (err) {
      console.error('[replay] fix recording failed:', err.message)
    }
  }

  // ------------------------------------------------------------ persistence

  function enqueueRow(rec) {
    rec.queue = rec.queue
      .then(() =>
        store.insertMatch({
          id: rec.matchId,
          lobbyCode: rec.lobbyCode,
          startedAt: rec.startedAt,
          settings: rec.settings,
          players: rec.players,
        }),
      )
      .catch((err) => {
        console.error('[replay] match row failed, retrying:', err.message)
        // Retry with the next flush — event inserts would otherwise fail on
        // the missing row forever.
        rec.rowQueued = false
      })
  }

  function enqueueFlush(rec) {
    if (rec.buffer.length) {
      const batch = rec.buffer
      rec.buffer = []
      rec.queue = rec.queue
        .then(() => store.insertEvents(rec.matchId, batch))
        .catch((err) => {
          console.error('[replay] event batch failed, re-buffering:', err.message)
          rec.buffer.unshift(...batch)
          if (rec.buffer.length > BUFFER_MAX) rec.buffer.splice(0, rec.buffer.length - BUFFER_MAX)
        })
    }
    return rec.queue
  }

  /** Finish a recording: final flush + result row, then stop observing. */
  function close(rec, { stale = false } = {}) {
    enqueueFlush(rec)
    const winner = stale ? null : (rec.over?.winner ?? null)
    const reason = stale ? 'Match abgebrochen (Server-Neustart)' : (rec.over?.reason ?? null)
    rec.queue = rec.queue
      .then(() =>
        store.finishMatch(rec.matchId, {
          endedAt: new Date(rec.lastEventAt),
          winner,
          reason,
          eventCount: rec.seq,
        }),
      )
      .then(() => enqueuePlayerStats(rec))
      .catch((err) => console.error('[replay] match finish failed:', err.message))
    recordings.delete(rec.lobbyCode)
  }

  /**
   * Derive this match's player stats from the stored event stream (the DB is
   * the source of truth — robust even if the in-memory buffer was truncated
   * during a DB outage) and persist them. Runs after the match row and all
   * events are written; failures must not break the recording itself.
   */
  function enqueuePlayerStats(rec) {
    return store
      .getEvents(rec.matchId)
      .then((events) => store.insertPlayerStats(rec.matchId, summarizePlayers(events)))
      .catch((err) => console.error('[replay] player stats failed:', err.message))
  }

  /**
   * Boot-time backfill: matches recorded before the stats table existed get
   * their player stats derived now (idempotent — only matches without rows).
   */
  async function backfillStats() {
    try {
      const ids = await store.matchesWithoutStats()
      for (const id of ids) await enqueuePlayerStats({ matchId: id })
      if (ids.length) console.log(`[replay] player stats backfilled for ${ids.length} match(es)`)
    } catch (err) {
      console.error('[replay] stats backfill failed:', err.message)
    }
  }

  const flusher = setInterval(() => {
    for (const rec of recordings.values()) {
      if (!rec.rowQueued && rec.buffer.length) {
        rec.rowQueued = true
        enqueueRow(rec)
      }
      enqueueFlush(rec)
      // Safety net for matches that die silently (everyone disconnects —
      // no game:over ever arrives): seal them after the quiet period.
      if (Date.now() - rec.lastEventAt > STALE_MS) close(rec, { stale: true })
    }
  }, FLUSH_INTERVAL_MS)
  flusher.unref?.()

  /** Test/shutdown helper: flush everything that is still open. */
  async function flushAll() {
    await Promise.all([...recordings.values()].map((rec) => enqueueFlush(rec)))
  }

  return { enabled: true, wrapIo, recordFix, flushAll, backfillStats }
}
