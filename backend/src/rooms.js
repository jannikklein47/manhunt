/**
 * Room registry & real-time game engine.
 *
 * All timers are derived from the host-configured `settings` — there are no
 * hardcoded magic durations. Distances and zone membership are computed with
 * @turf/turf.
 */
import { randomUUID } from 'node:crypto'
import { point, distance, destination } from '@turf/turf'
import { sanitizeSettings, mergeSettings } from './settings.js'

/** Room codes: unambiguous alphabet (no I/L/O/0/1). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 4

/** Below this the zone stops shrinking so the game stays playable. */
export const MIN_ZONE_RADIUS = 20

/** Fixes worse than this are junk (city-level) and dropped entirely. */
export const GPS_MAX_REPORT = 100

/**
 * Quality bar for game decisions (spec §4.2). Fixes at least this accurate
 * are trusted for proximity alerts and out-of-zone exposure; weaker fixes
 * still update map positions but must not trigger a 25 m proximity alarm
 * with 90 m error.
 */
export const GPS_QUALITY_MAX = 25

/** How long an empty room lingers before it is deleted (reconnect grace). */
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000

export class GameError extends Error {}

function generateRoomCode(existing) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    }
    if (!existing.has(code)) return code
  }
  throw new GameError('Raumcode konnte nicht erstellt werden, bitte erneut versuchen')
}

function isValidZoneCenter(center) {
  return (
    !!center &&
    typeof center.lat === 'number' &&
    typeof center.lng === 'number' &&
    Number.isFinite(center.lat) &&
    Number.isFinite(center.lng) &&
    Math.abs(center.lat) <= 90 &&
    Math.abs(center.lng) <= 180
  )
}

function isValidFix({ lat, lng, accuracy } = {}) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    (accuracy === undefined || (typeof accuracy === 'number' && Number.isFinite(accuracy)))
  )
}

/** Pure helper (exported for tests): one shrink tick. */
export function applyShrink(radiusMeters, percent) {
  return Math.max(MIN_ZONE_RADIUS, Math.round(radiusMeters * (1 - percent / 100)))
}

/**
 * Pure helper (exported for tests): one random zone drift. The zone does not
 * only shrink — each shrink tick it also wanders up to its full radius in a
 * uniformly random direction. `rng` is injectable for deterministic tests.
 */
export function applyZoneShift(center, radiusMeters, rng = Math.random) {
  const dist = rng() * radiusMeters // 0 … 1× the current radius
  if (dist === 0) return { lat: center.lat, lng: center.lng } // exact no-move
  const bearing = rng() * 360
  const next = destination(point([center.lng, center.lat]), dist, bearing, { units: 'meters' })
  const [lng, lat] = next.geometry.coordinates
  return { lat, lng }
}

/** Pure helper (exported for tests): turf-based distance in meters. */
export function distanceMeters(a, b) {
  return distance(point([a.lng, a.lat]), point([b.lng, b.lat])) * 1000
}

export class Room {
  constructor(io, code, { hostName, role, zoneCenter, settings }) {
    this.io = io
    this.code = code
    this.settings = sanitizeSettings(settings)
    this.zoneCenter = { lat: zoneCenter.lat, lng: zoneCenter.lng }
    // Pristine host-picked center — the live one drifts during the match;
    // rematches start() back here.
    this.initialZoneCenter = { ...this.zoneCenter }
    this.currentZoneRadius = this.settings.initialZoneRadius
    this.timeRemaining = this.settings.gameDurationSeconds
    this.elapsed = 0
    this.status = 'lobby' // 'lobby' | 'active' | 'ended'
    this.phase = 'main' // while active: 'hiding' | 'main' | 'endgame'
    this.hideRemaining = 0
    /**
     * Endgame preview, announced in the main phase once no more shrink ticks
     * lie between "now" and the switch: the frozen zone (center + radius) the
     * hiders must reach before the endgame begins. Rendered as a second,
     * pulsating yellow circle on every player's map. Cleared at the switch.
     * @type {{ lat: number, lng: number, radius: number } | null}
     */
    this.endgameZone = null
    /** Seconds left in the endgame phase (counts down from `endgameDurationSeconds`). */
    this.endgameRemaining = 0
    this.players = new Map() // playerId -> Player
    this.hostId = null
    /** Last `game:over` payload — rides along in room state so a client
     *  that refreshes after the game still sees the correct result. */
    this.lastGameOver = null

    /** @type {ReturnType<typeof setInterval> | null} */
    this.tickTimer = null
    /** @type {ReturnType<typeof setInterval> | null} */
    this.revealTimer = null

    const host = this.addPlayer(null, { name: hostName, role })
    // The host socket is bound right after via `bindSocket` in the socket layer.
    this.hostId = host.id
  }

  // ---------------------------------------------------------------- players

  addPlayer(socket, { name, role }) {
    const player = {
      id: randomUUID(),
      name: String(name).trim().slice(0, 24),
      role: role === 'hider' ? 'hider' : 'hunter',
      connected: false,
      socketId: null,
      lastLocation: null,
      revealedLocation: null,
      isExposedLive: false,
      inRange: false,
      captured: false,
      capturedBy: null,
      /** Why the hider is out: 'caught' (reported) or 'endzone' (missed the
       *  endgame deadline). Only meaningful when `captured` is true. */
      capturedReason: null,
    }
    this.players.set(player.id, player)
    if (socket) this.bindSocket(player, socket)
    return player
  }

  bindSocket(player, socket) {
    player.connected = true
    player.socketId = socket.id
    socket.data.roomCode = this.code
    socket.data.playerId = player.id
    socket.join(this.code)
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected)
  }

  playersWithRole(role) {
    return [...this.players.values()].filter((p) => p.role === role)
  }

  /** A disconnected player rejoins by reusing their old player entry. */
  reconnectPlayer(existing, socket, role) {
    existing.connected = true
    existing.socketId = socket.id
    if (this.status === 'lobby' && role) existing.role = role === 'hider' ? 'hider' : 'hunter'
    this.bindSocket(existing, socket)
    return existing
  }

  removePlayer(player) {
    this.players.delete(player.id)
    // Host heir applies in the lobby and after a game (an ended room without
    // a host could never be restarted).
    const reassignHost = this.status === 'lobby' || this.status === 'ended'
    if (reassignHost && player.id === this.hostId) {
      const heir = this.connectedPlayers()[0]
      if (heir) this.hostId = heir.id
    }
    if (this.players.size === 0) {
      this.destroy()
    } else {
      this.broadcastState()
    }
  }

  markDisconnected(socketId) {
    const player = [...this.players.values()].find((p) => p.socketId === socketId)
    if (!player) return null
    player.connected = false
    player.socketId = null
    if (player.role === 'hider' && player.inRange) {
      player.inRange = false
      this.emitTo(player, 'player:proximity_alert', { inRange: false, interval: this.settings.proximityBeepInterval })
    }
    if (this.connectedPlayers().length === 0) {
      this.scheduleCleanup()
    }
    this.broadcastState()
    return player
  }

  scheduleCleanup() {
    setTimeout(() => {
      const anyone = this.connectedPlayers().length > 0
      if (!anyone) rooms.delete(this.code)
      // Keep reference alive either way; if someone reconnected the room survives.
    }, EMPTY_ROOM_TTL_MS)
  }

  destroy() {
    this.clearTimers()
    rooms.delete(this.code)
  }

  // ------------------------------------------------------------------ io

  emitTo(player, event, payload) {
    if (player.socketId) this.io.to(player.socketId).emit(event, payload)
  }

  emitToRole(role, event, payload) {
    for (const player of this.players.values()) {
      if (player.role === role && player.connected) this.emitTo(player, event, payload)
    }
  }

  /**
   * SEAMLESS REJOIN: a freshly (re)bound client knows nothing about the
   * room's live data — broadcasts are change-driven, so in a quiet room the
   * map would stay empty until someone moves. Push everything the client
   * needs to resume instantly:
   * - the position lists for ITS role (hunters in the hiding phase get no
   *   hider data at all; an active hunter gets the reveal-scoped list; the
   *   lobby and hider team get the live team list),
   * - the current proximity state (restores the beep loop mid-alert),
   * - nothing when the game has ended — pins are wiped at 'ended' and the
   *   result travels in room state (`gameOver`).
   */
  sendResync(player, socket) {
    if (this.status !== 'lobby' && this.status !== 'active') return
    // Endgame: hunters are invisible to hiders — a (re)joining hider gets an
    // empty list so no stale pins from before the switch can appear.
    const huntersDark = this.status === 'active' && this.phase === 'endgame'
    socket.emit(
      'map:hunter_positions',
      huntersDark && player.role === 'hider' ? [] : this.hunterListPayload(),
    )
    const hunterMustWait =
      this.status === 'active' && this.phase === 'hiding' && player.role === 'hunter'
    if (!hunterMustWait) {
      const revealScoped = this.status === 'active' && player.role === 'hunter'
      socket.emit('map:hider_positions', this.hiderListPayload(revealScoped))
    }
    if (player.role === 'hider') {
      socket.emit('player:proximity_alert', {
        inRange: player.inRange,
        interval: this.settings.proximityBeepInterval,
      })
    }
  }

  broadcastState() {
    this.io.to(this.code).emit('room:state_changed', { roomState: this.serialize() })
  }

  /**
   * Public RoomState. Players are serialized WITHOUT coordinates — live
   * positions only travel over the dedicated `map:*_positions` events, so
   * hunters can never extract hider locations from room state.
   */
  serialize() {
    const players = {}
    for (const player of this.players.values()) {
      players[player.id] = {
        id: player.id,
        name: player.name,
        role: player.role,
        connected: player.connected,
        isExposedLive: player.isExposedLive,
        inRange: player.inRange,
        captured: player.captured,
        capturedBy: player.capturedBy,
        capturedReason: player.capturedReason,
      }
    }
    return {
      code: this.code,
      hostId: this.hostId,
      settings: { ...this.settings },
      zoneCenter: { ...this.zoneCenter },
      currentZoneRadius: this.currentZoneRadius,
      endgameZone: this.endgameZone ? { ...this.endgameZone } : null,
      endgameRemaining: this.endgameRemaining,
      timeRemaining: this.timeRemaining,
      status: this.status,
      phase: this.phase,
      hideRemaining: this.hideRemaining,
      gameOver: this.lastGameOver ? { ...this.lastGameOver } : null,
      players,
    }
  }

  // ------------------------------------------------------------- settings

  updateSettings(requestedBy, patch) {
    this.assertHost(requestedBy)
    if (this.status !== 'lobby') throw new GameError('Einstellungen können nur in der Lobby geändert werden')
    this.settings = mergeSettings(this.settings, patch)
    // Lobby-only: the zone radius preview must follow the slider immediately.
    this.currentZoneRadius = this.settings.initialZoneRadius
    this.broadcastState()
    return this.settings
  }

  /**
   * Host extension: re-place the zone center on the map (lobby only). Also
   * re-anchors rematches — start()/resetToLobby() restore this center.
   */
  setZoneCenter(requestedBy, center) {
    this.assertHost(requestedBy)
    if (this.status !== 'lobby') throw new GameError('Die Zone kann nur in der Lobby verschoben werden')
    if (!isValidZoneCenter(center)) throw new GameError('Ein gültiges Zentrum der Zone (lat/lng) wird benötigt')
    this.zoneCenter = { lat: center.lat, lng: center.lng }
    this.initialZoneCenter = { ...this.zoneCenter }
    this.broadcastState()
    return { ...this.zoneCenter }
  }

  assertHost(player) {
    if (!player || player.id !== this.hostId) throw new GameError('Nur der Host kann das')
  }

  assertMember(socket) {
    const playerId = socket.data?.playerId
    const player = playerId ? this.players.get(playerId) : null
    if (!player || !player.connected || player.socketId !== socket.id) {
      throw new GameError('Du gehörst nicht zu diesem Raum')
    }
    return player
  }

  // ------------------------------------------------------------ game flow

  start(requestedBy) {
    this.assertHost(requestedBy)
    if (this.status !== 'lobby') throw new GameError('Spiel hat bereits begonnen')

    const active = this.connectedPlayers()
    if (!active.some((p) => p.role === 'hunter') || !active.some((p) => p.role === 'hider')) {
      throw new GameError('Zum Start wird mindestens ein Jäger und ein Verstecker gebraucht')
    }

    this.status = 'active'
    this.elapsed = 0
    this.timeRemaining = this.settings.gameDurationSeconds
    this.lastGameOver = null
    this.currentZoneRadius = this.settings.initialZoneRadius
    this.zoneCenter = { ...this.initialZoneCenter }
    this.phase = this.settings.hidePhaseSeconds > 0 ? 'hiding' : 'main'
    this.hideRemaining = this.phase === 'hiding' ? this.settings.hidePhaseSeconds : 0
    this.endgameZone = null
    this.endgameRemaining = 0

    for (const player of this.players.values()) {
      player.captured = false
      player.capturedBy = null
      player.capturedReason = null
      player.inRange = false
      player.isExposedLive = false
      player.lastLocation = null
      player.revealedLocation = null
    }

    // Dynamic timers — the 1 s tick always runs; hider reveals only start
    // once the (optional) hiding phase is over.
    this.clearTimers()
    this.tickTimer = setInterval(() => this.tick(), 1000)

    this.broadcastState()
    this.emitTick()

    if (this.phase === 'main') this.beginMainPhase()
    this.broadcastHunterPositions()
  }

  /** Transition hiding → main: hider reveals start, first snapshot goes out. */
  beginMainPhase() {
    this.phase = 'main'
    if (!this.revealTimer) {
      this.revealTimer = setInterval(() => this.revealHiders(), this.settings.hiderRevealInterval * 1000)
    }
    // First reveal fires the moment the hunt begins.
    this.revealHiders()
  }

  /**
   * Periodic REVEAL: hunters receive a fresh hider snapshot and the whole
   * room gets a `hiders:revealed` notice — hiders use it for their
   * "next reveal" countdown and the reveal wave animation on their own pin.
   * Boundary-driven updates (out-of-zone exposure) are NOT reveals and use
   * plain `emitHiderSnapshot()` instead.
   */
  revealHiders() {
    // Freeze what this reveal shows: between periodic reveals, hunter-facing
    // payloads carry these coordinates — so a live update for ONE exposed
    // hider can never carry the others' current fixes.
    for (const hider of this.playersWithRole('hider')) {
      hider.revealedLocation = hider.lastLocation ? { ...hider.lastLocation } : null
    }
    this.emitHiderSnapshot()
    this.io.to(this.code).emit('hiders:revealed', { at: Date.now() })
  }

  clearTimers() {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.revealTimer) clearInterval(this.revealTimer)
    this.tickTimer = null
    this.revealTimer = null
  }

  tick() {
    // HIDING PHASE: hiders get their head start — no countdown, no shrinking,
    // no reveals, no proximity alerts.
    if (this.phase === 'hiding') {
      this.hideRemaining = Math.max(0, this.hideRemaining - 1)
      if (this.hideRemaining === 0) this.beginMainPhase()
      this.emitTick()
      return
    }

    this.elapsed++
    this.timeRemaining = Math.max(0, this.settings.gameDurationSeconds - this.elapsed)

    // ENDGAME PHASE: the classic shrink-and-move is suspended — the zone only
    // gets smaller every second, approaching the final radius. The match ends
    // when the endgame countdown hits zero.
    if (this.phase === 'endgame') {
      this.endgameRemaining = Math.max(0, this.endgameRemaining - 1)
      this.approachEndgameRadius()
      this.emitTick()
      if (this.endgameRemaining === 0) {
        const uncaught = this.playersWithRole('hider').filter((p) => !p.captured).length
        if (uncaught > 0) {
          this.endGame(
            'hiders',
            `Endgame beendet — ${uncaught} Verstecker${uncaught === 1 ? ' ist' : ' sind'} übrig geblieben`,
          )
        } else {
          this.endGame('hunters', 'Endgame beendet — alle Verstecker wurden gefunden')
        }
      }
      return
    }

    // MAIN PHASE. Once the endgame zone is announced (notice window open),
    // the classic shrink-and-move is suspended — the announced coming zone
    // must stay exact until the switch (see announceEndgameZone).
    const endgameStartsNow = this.endgameStartsNow()
    if (
      !endgameStartsNow &&
      !this.endgameZone &&
      this.elapsed % this.settings.zoneShrinkInterval === 0
    ) {
      this.shrinkZone()
    }
    this.announceEndgameZone()

    if (endgameStartsNow) {
      this.beginEndgamePhase()
      // The endzone check can end the match on the spot — no tick afterwards.
      if (this.status === 'active') this.emitTick()
      return
    }

    this.emitTick()

    if (this.timeRemaining === 0) {
      const uncaught = this.playersWithRole('hider').filter((p) => !p.captured).length
      if (uncaught > 0) {
        this.endGame('hiders', `Zeit abgelaufen — ${uncaught} Verstecker${uncaught === 1 ? ' ist' : ' sind'} entkommen`)
      } else {
        this.endGame('hunters', 'Zeit abgelaufen — alle Verstecker wurden bereits gefunden')
      }
    }
  }

  /** Does the endgame switch happen on this tick (main time up, endgame on)? */
  endgameStartsNow() {
    return (
      this.settings.endgameEnabled &&
      this.settings.endgameDurationSeconds > 0 &&
      this.timeRemaining === 0
    )
  }

  /**
   * ENDGAME PREVIEW: when the notice window opens (`endgameNoticeSeconds`
   * before the switch), the coming endgame zone is computed and shown to ALL
   * players as a second, pulsating yellow circle so every hider has time to
   * run for it. The coming zone is one classic shrink-and-move — its random
   * drift is rolled HERE, so the announced preview IS exactly the zone the
   * switch will apply. The notice window doubles as the guarantee that the
   * LAST classic shrink happened at least that long before the switch: every
   * shrink inside the window is suspended (see tick()), so the live zone
   * stays put from announcement to switch and the prediction is exact.
   */
  announceEndgameZone() {
    if (!this.settings.endgameEnabled || this.endgameZone) return
    if (this.timeRemaining > this.settings.endgameNoticeSeconds) return
    const radius = applyShrink(this.currentZoneRadius, this.settings.zoneShrinkPercent)
    const center = this.settings.zoneShiftEnabled
      ? applyZoneShift(this.zoneCenter, radius)
      : { lat: this.zoneCenter.lat, lng: this.zoneCenter.lng }
    this.endgameZone = { lat: center.lat, lng: center.lng, radius }
    this.broadcastState()
  }

  /**
   * Transition main → endgame: the switch applies the announced coming zone
   * (one classic shrink-and-move), every hider that failed to enter it before
   * the switch is out; afterwards the normal match logic continues (reveals,
   * exposure, proximity) — being outside the zone is no longer instantly
   * fatal. Hunters go dark for the hiders from here on.
   */
  beginEndgamePhase() {
    const target = this.endgameZone || {
      lat: this.zoneCenter.lat,
      lng: this.zoneCenter.lng,
      radius: this.currentZoneRadius,
    }
    this.phase = 'endgame'
    this.endgameRemaining = this.settings.endgameDurationSeconds

    // THE SWITCH: shrink and move the zone exactly as announced — the yellow
    // preview becomes the real zone.
    this.currentZoneRadius = target.radius
    this.zoneCenter = { lat: target.lat, lng: target.lng }

    for (const hider of this.playersWithRole('hider')) {
      if (hider.captured || !hider.lastLocation) continue
      if (distanceMeters(hider.lastLocation, target) > target.radius) {
        hider.captured = true
        hider.capturedBy = null
        hider.capturedReason = 'endzone'
        if (hider.inRange) {
          hider.inRange = false
          this.emitTo(hider, 'player:proximity_alert', {
            inRange: false,
            interval: this.settings.proximityBeepInterval,
          })
        }
      }
    }

    // The preview has done its job — from here the (green) zone itself closes
    // in, so the yellow circle comes down with the switch.
    this.endgameZone = null

    // HUNTERS GO DARK: hiders no longer receive hunter positions…
    this.emitToRole('hider', 'map:hunter_positions', [])
    // …while everything else keeps flowing: the new dead pins reach the
    // hunters immediately, the hider team list carries the new outs, and the
    // state broadcast flips every client into the endgame phase.
    this.emitHiderSnapshot()
    this.emitToRole('hider', 'map:hider_positions', this.hiderListPayload())

    // The endzone check can wipe out the LAST hiders — that ends the match
    // right away, exactly like a reported capture of the final hider would.
    const remaining = this.playersWithRole('hider').filter((p) => !p.captured).length
    if (remaining === 0) {
      this.endGame('hunters', 'Kein Verstecker hat es in die Endzone geschafft')
      return
    }
    this.broadcastState()
  }

  /**
   * ENDGAME APPROACH: every second the radius takes one step toward
   * `endgameMinZoneRadius`, sized so the zone reaches it exactly when the
   * phase (and thus the match) ends. Normal shrink ticks keep running
   * alongside — this step recomputes each second, so the target is still hit
   * on time ("approach": the zone never grows back past the final radius).
   */
  approachEndgameRadius() {
    const min = Math.max(MIN_ZONE_RADIUS, this.settings.endgameMinZoneRadius)
    const secondsLeft = this.endgameRemaining
    if (secondsLeft <= 0 || this.currentZoneRadius <= min) return
    const step = (this.currentZoneRadius - min) / secondsLeft
    this.currentZoneRadius = Math.max(min, Math.round(this.currentZoneRadius - step))
  }

  shrinkZone() {
    this.currentZoneRadius = applyShrink(this.currentZoneRadius, this.settings.zoneShrinkPercent)
    // …and it wanders: up to its full (new) radius in a random direction —
    // but only when the host left the drift enabled.
    if (this.settings.zoneShiftEnabled) {
      this.zoneCenter = applyZoneShift(this.zoneCenter, this.currentZoneRadius)
    }
    // A smaller or moved zone can push hiders outside it → re-evaluate exposure.
    for (const hider of this.playersWithRole('hider')) {
      this.updateHiderExposure(hider)
    }
  }

  nextShrinkIn() {
    const interval = this.settings.zoneShrinkInterval
    return interval - (this.elapsed % interval)
  }

  /**
   * Seconds until the next periodic hider reveal. Anchored to `elapsed`
   * (main-phase seconds), matching the revealTimer started at main-phase
   * begin — so hunters and hiders can both show an accurate countdown.
   */
  nextRevealIn() {
    const interval = this.settings.hiderRevealInterval
    return interval - (this.elapsed % interval)
  }

  emitTick() {
    this.io.to(this.code).emit('game:tick', {
      timeRemaining: this.timeRemaining,
      currentZoneRadius: this.currentZoneRadius,
      zoneCenter: { ...this.zoneCenter },
      endgameZone: this.endgameZone ? { ...this.endgameZone } : null,
      endgameRemaining: this.endgameRemaining,
      // null while the next classic shrink is suspended — clients hide the
      // „Schrumpfen in“ chip instead of counting down to a no-op shrink.
      nextShrinkIn: this.nextShrinkScheduledIn(),
      // Seconds until the notice window opens (the preview announcement) —
      // null while that countdown is not running. Clients show it as the
      // „Endgame-Zone in“ chip while the shrink countdown is suspended.
      endgameNoticeIn: this.endgameNoticeScheduledIn(),
      nextRevealIn: this.nextRevealIn(),
      phase: this.phase,
      hideRemaining: this.hideRemaining,
    })
  }

  /**
   * Seconds until the next classic shrink — or null while that shrink is
   * SUSPENDED by the endgame:
   * - once the endgame preview is announced (and for the whole endgame
   *   phase), every classic shrink is skipped;
   * - already BEFORE the announcement: when the notice window would open
   *   strictly before the next shrink tick, that shrink is suspended too —
   *   counting down to it would be a lie.
   * A shrink falling exactly ON the tick the notice window opens still runs
   * (shrink first, then announcement), so the chip stays honest there.
   */
  nextShrinkScheduledIn() {
    const raw = this.nextShrinkIn()
    if (!this.settings.endgameEnabled) return raw
    if (this.endgameZone || this.phase === 'endgame') return null
    const untilAnnouncement = this.timeRemaining - this.settings.endgameNoticeSeconds
    if (this.phase === 'main' && untilAnnouncement < raw) return null
    return raw
  }

  /**
   * Seconds until the endgame notice window opens and the coming endgame
   * zone is announced — or null while that countdown is not running (endgame
   * disabled, preview already up, or the endgame phase itself). The UI shows
   * it as the „Endgame-Zone in …“ chip exactly when the shrink countdown is
   * suspended by the upcoming window (nextShrinkIn null) but the preview is
   * not up yet — the gap the old chip left blank.
   */
  endgameNoticeScheduledIn() {
    if (!this.settings.endgameEnabled) return null
    if (this.phase !== 'main' || this.endgameZone) return null
    return Math.max(0, this.timeRemaining - this.settings.endgameNoticeSeconds)
  }

  // ----------------------------------------------------------- visibility

  /** Hunter-facing snapshot of ALL hiders — periodic reveals AND the
   *  exposure-driven live updates. */
  emitHiderSnapshot() {
    this.emitToRole('hunter', 'map:hider_positions', this.hiderListPayload(true))
  }

  /**
   * Full hider list for `map:hider_positions` (clients replace their marker
   * set wholesale).
   *
   * - Team view (`forHunters` false — the hider channel, lobby, after
   *   reset): always the latest fix; hiders see their team live.
   * - Hunter view (`forHunters` true): exposed hiders stream their latest
   *   fix and captured hiders carry the capture spot — every OTHER hider
   *   carries their frozen spot (`revealedLocation`: the last periodic
   *   reveal, or after re-entry the last live position the hunters
   *   watched), so a live update for one exposed hider never re-reveals
   *   where the currently hidden hiders are right now.
   */
  hiderListPayload(forHunters = false) {
    return this.playersWithRole('hider').map((hider) =>
      this.hiderPositionPayload(hider, hider.isExposedLive, forHunters),
    )
  }

  hiderPositionPayload(hider, isExposedLive, forHunters = false) {
    const streamsLive = isExposedLive || hider.captured
    const loc = forHunters && !streamsLive ? hider.revealedLocation : hider.lastLocation
    return {
      id: hider.id,
      name: hider.name,
      lat: loc ? loc.lat : null,
      lng: loc ? loc.lng : null,
      isExposedLive,
    }
  }

  /**
   * OUT-OF-ZONE EXCEPTION: while a hider is outside the zone their position
   * streams live to hunters; the flag flips back once they re-enter.
   * Suppressed during the hiding phase — hider positions don't flow to
   * hunters until the hunt begins.
   */
  updateHiderExposure(hider) {
    if (!hider.lastLocation) return
    const dist = distanceMeters(hider.lastLocation, this.zoneCenter)
    const inZone = dist <= this.currentZoneRadius
    const wasExposed = hider.isExposedLive
    hider.isExposedLive = !inZone

    if (wasExposed && !hider.isExposedLive) {
      // RE-ENTRY: the hunters just watched this hider walk back in — keep
      // their pin where it is by freezing the hunter-facing spot at his last
      // live fix. Falling back to the old periodic reveal would rewind the
      // pin (potentially far) to a position the hunters had long ago.
      hider.revealedLocation = { ...hider.lastLocation }
    }
    if (hider.isExposedLive || wasExposed !== hider.isExposedLive) {
      // Live update while outside — only the exposed hider carries fresh
      // coordinates, everyone else stays frozen at their last reveal or
      // re-entry spot. On re-entry one final update flips the flag and
      // leaves the pin where it is (see above).
      if (this.phase !== 'hiding') this.emitHiderSnapshot()
    }
    if (wasExposed !== hider.isExposedLive) {
      // The hider must learn about their own exposure flip immediately —
      // e.g. when the shrinking zone drifts past a stationary hider who
      // won't send a fresh GPS fix for a while — so their own dot turns
      // yellow (and waves) the moment it happens.
      this.emitToRole('hider', 'map:hider_positions', this.hiderListPayload())
    }
  }

  /**
   * Hunters are public — stream their positions to the whole room. During the
   * endgame they go dark for the hiders: only the hunter team sees hunters.
   */
  broadcastHunterPositions() {
    if (this.status === 'active' && this.phase === 'endgame') {
      this.emitToRole('hunter', 'map:hunter_positions', this.hunterListPayload())
      return
    }
    this.io.to(this.code).emit('map:hunter_positions', this.hunterListPayload())
  }

  hunterListPayload() {
    return this.playersWithRole('hunter')
      .filter((h) => h.lastLocation)
      .map((hunter) => ({
        id: hunter.id,
        name: hunter.name,
        lat: hunter.lastLocation.lat,
        lng: hunter.lastLocation.lng,
      }))
  }

  // ------------------------------------------------------------- location

  /**
   * Ingest a GPS fix. Returns true when the fix was accepted (valid, fresh
   * enough and from an eligible player) — the replay recorder logs exactly
   * those; false for rejected junk.
   */
  handleLocation(player, { lat, lng, accuracy } = {}) {
    if (!isValidFix({ lat, lng, accuracy })) return false
    const acc = typeof accuracy === 'number' ? accuracy : 0
    if (acc > GPS_MAX_REPORT) return false // junk fix (city-level) — ignore

    // LOBBY: no game mechanics — but everyone sees everyone, so every
    // accepted fix rebroadcasts both roles to the whole room.
    if (this.status === 'lobby') {
      player.lastLocation = { lat, lng, accuracy: acc, at: Date.now(), quality: acc <= GPS_QUALITY_MAX }
      this.broadcastHunterPositions()
      this.io.to(this.code).emit('map:hider_positions', this.hiderListPayload())
      return true
    }

    if (this.status !== 'active') return false
    if (player.captured) return false

    player.lastLocation = { lat, lng, accuracy: acc, at: Date.now(), quality: acc <= GPS_QUALITY_MAX }

    if (player.role === 'hider') {
      // Only quality fixes may flip exposure — a 90 m-error fix must not
      // leak a hider that is actually inside the zone.
      if (player.lastLocation.quality) this.updateHiderExposure(player)
      // Team visibility: hiders always see each other's latest positions.
      // (Sent to the hider role only — never leaks to hunters between reveals.)
      this.emitToRole('hider', 'map:hider_positions', this.hiderListPayload())
    } else {
      this.broadcastHunterPositions()
    }
    this.evaluateProximity()
    return true
  }

  /**
   * PROXIMITY ALERT: for every (uncaptured) hider, check whether any hunter
   * is within `proximityDistanceMeters` using @turf/distance. The hider is
   * notified on every state change; the client repeats the beep on the
   * configured `proximityBeepInterval` until `inRange` flips back to false.
   *
   * Both players need their LATEST fix to be quality (≤ 25 m) — a proximity
   * alarm computed from a sloppy fix would be a false alarm. Disabled during
   * the hiding phase.
   */
  evaluateProximity() {
    if (this.status !== 'active' || this.phase === 'hiding') return
    const threshold = this.settings.proximityDistanceMeters
    const hunters = this.playersWithRole('hunter').filter(
      (h) => h.connected && h.lastLocation?.quality && !h.captured,
    )

    for (const hider of this.playersWithRole('hider')) {
      if (hider.captured || !hider.connected || !hider.lastLocation?.quality) continue

      const inRange = hunters.some((hunter) => distanceMeters(hider.lastLocation, hunter.lastLocation) <= threshold)
      if (inRange !== hider.inRange) {
        hider.inRange = inRange
        this.emitTo(hider, 'player:proximity_alert', { inRange, interval: this.settings.proximityBeepInterval })
      }
    }
  }

  // -------------------------------------------------------------- capture

  captureHider(requestedBy, hiderId, hunterId) {
    if (this.status !== 'active') throw new GameError('Es läuft kein Spiel')
    // A capture can only be reported by the hider themselves ("Found by" tap).
    if (requestedBy.id !== hiderId) throw new GameError('Nur der Verstecker selbst kann den Fang melden')

    const hider = this.players.get(hiderId)
    const hunter = this.players.get(hunterId)
    if (!hider || hider.role !== 'hider') throw new GameError('Unbekannter Verstecker')
    if (!hunter || hunter.role !== 'hunter') throw new GameError('Unbekannter Jäger')
    if (hider.captured) throw new GameError('Verstecker wurde bereits gefangen')

    hider.captured = true
    hider.capturedBy = hunterId
    hider.capturedReason = 'caught'
    if (hider.inRange) {
      hider.inRange = false
      this.emitTo(hider, 'player:proximity_alert', { inRange: false, interval: this.settings.proximityBeepInterval })
    }

    const remaining = this.playersWithRole('hider').filter((p) => !p.captured).length
    if (remaining === 0) {
      // Single terminal broadcast: state (ended) + game:over, in that order.
      this.endGame('hunters', `Alle Verstecker gefunden — der letzte gefangen von ${hunter.name}`)
    } else {
      // IMMEDIATE DEAD PIN: the found hider's frozen position must reach
      // everyone right away — hunters see the dead pin jump to the capture
      // spot at once instead of showing the stale last-reveal position until
      // the next reveal. Hiders get the team list for the same reason.
      this.emitHiderSnapshot()
      this.emitToRole('hider', 'map:hider_positions', this.hiderListPayload())
      this.broadcastState()
    }
  }

  // ------------------------------------------------------------ game over

  endGame(winner, reason) {
    this.clearTimers()
    this.status = 'ended'
    this.lastGameOver = { winner, reason }
    this.broadcastState()
    this.io.to(this.code).emit('game:over', { winner, reason })
  }

  /** Host extension: reset an ended match back to a fresh lobby. */
  resetToLobby(requestedBy) {
    this.assertHost(requestedBy)
    if (this.status !== 'ended') throw new GameError('Das Spiel ist noch nicht vorbei')
    this.status = 'lobby'
    this.phase = 'main'
    this.hideRemaining = 0
    this.lastGameOver = null
    this.elapsed = 0
    this.timeRemaining = this.settings.gameDurationSeconds
    this.currentZoneRadius = this.settings.initialZoneRadius
    this.zoneCenter = { ...this.initialZoneCenter }
    this.endgameZone = null
    this.endgameRemaining = 0
    for (const player of this.players.values()) {
      player.captured = false
      player.capturedBy = null
      player.capturedReason = null
      player.inRange = false
      player.isExposedLive = false
      player.revealedLocation = null
    }
    this.broadcastState()
    // Reopen the lobby WITH everyone's last known position — players are
    // still standing where the game ended, so both lists go out immediately
    // instead of waiting for the first movement-based fix.
    this.broadcastHunterPositions()
    this.io.to(this.code).emit('map:hider_positions', this.hiderListPayload())
  }
}

/** @type {Map<string, Room>} */
export const rooms = new Map()

export function createRoom(io, { hostName, zoneCenter, settings, role }) {
  if (!isValidZoneCenter(zoneCenter)) throw new GameError('Ein gültiges Zentrum der Zone (lat/lng) wird benötigt')
  const code = generateRoomCode(rooms)
  const room = new Room(io, code, { hostName, role, zoneCenter, settings })
  rooms.set(code, room)
  return room
}

export function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase())
  if (!room) throw new GameError('Raum nicht gefunden — prüfe den Code')
  return room
}
