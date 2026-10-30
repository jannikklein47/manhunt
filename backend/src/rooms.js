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
  throw new GameError('Could not allocate a room code, try again')
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
    this.phase = 'main' // while active: 'hiding' | 'main'
    this.hideRemaining = 0
    this.players = new Map() // playerId -> Player
    this.hostId = null

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
      isExposedLive: false,
      inRange: false,
      captured: false,
      capturedBy: null,
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
      }
    }
    return {
      code: this.code,
      hostId: this.hostId,
      settings: { ...this.settings },
      zoneCenter: { ...this.zoneCenter },
      currentZoneRadius: this.currentZoneRadius,
      timeRemaining: this.timeRemaining,
      status: this.status,
      phase: this.phase,
      hideRemaining: this.hideRemaining,
      players,
    }
  }

  // ------------------------------------------------------------- settings

  updateSettings(requestedBy, patch) {
    this.assertHost(requestedBy)
    if (this.status !== 'lobby') throw new GameError('Settings can only be changed in the lobby')
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
    if (this.status !== 'lobby') throw new GameError('Zone can only be moved in the lobby')
    if (!isValidZoneCenter(center)) throw new GameError('A valid zone center (lat/lng) is required')
    this.zoneCenter = { lat: center.lat, lng: center.lng }
    this.initialZoneCenter = { ...this.zoneCenter }
    this.broadcastState()
    return { ...this.zoneCenter }
  }

  assertHost(player) {
    if (!player || player.id !== this.hostId) throw new GameError('Only the host can do that')
  }

  assertMember(socket) {
    const playerId = socket.data?.playerId
    const player = playerId ? this.players.get(playerId) : null
    if (!player || !player.connected || player.socketId !== socket.id) {
      throw new GameError('You are not part of this room')
    }
    return player
  }

  // ------------------------------------------------------------ game flow

  start(requestedBy) {
    this.assertHost(requestedBy)
    if (this.status !== 'lobby') throw new GameError('Game already started')

    const active = this.connectedPlayers()
    if (!active.some((p) => p.role === 'hunter') || !active.some((p) => p.role === 'hider')) {
      throw new GameError('Need at least one hunter and one hider to start')
    }

    this.status = 'active'
    this.elapsed = 0
    this.timeRemaining = this.settings.gameDurationSeconds
    this.currentZoneRadius = this.settings.initialZoneRadius
    this.zoneCenter = { ...this.initialZoneCenter }
    this.phase = this.settings.hidePhaseSeconds > 0 ? 'hiding' : 'main'
    this.hideRemaining = this.phase === 'hiding' ? this.settings.hidePhaseSeconds : 0

    for (const player of this.players.values()) {
      player.captured = false
      player.capturedBy = null
      player.inRange = false
      player.isExposedLive = false
      player.lastLocation = null
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

    if (this.elapsed % this.settings.zoneShrinkInterval === 0) {
      this.shrinkZone()
    }

    this.emitTick()

    if (this.timeRemaining === 0) {
      const uncaught = this.playersWithRole('hider').filter((p) => !p.captured).length
      if (uncaught > 0) {
        this.endGame('hiders', `Time ran out — ${uncaught} hider${uncaught === 1 ? '' : 's'} escaped`)
      } else {
        this.endGame('hunters', 'Time ran out — every hider was already found')
      }
    }
  }

  shrinkZone() {
    this.currentZoneRadius = applyShrink(this.currentZoneRadius, this.settings.zoneShrinkPercent)
    // …and it wanders: up to its full (new) radius in a random direction.
    this.zoneCenter = applyZoneShift(this.zoneCenter, this.currentZoneRadius)
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
      nextShrinkIn: this.nextShrinkIn(),
      nextRevealIn: this.nextRevealIn(),
      phase: this.phase,
      hideRemaining: this.hideRemaining,
    })
  }

  // ----------------------------------------------------------- visibility

  /** Snapshot of ALL hiders, sent to hunters every `hiderRevealInterval`. */
  emitHiderSnapshot() {
    this.emitToRole('hunter', 'map:hider_positions', this.hiderListPayload())
  }

  hiderListPayload() {
    return this.playersWithRole('hider').map((hider) => this.hiderPositionPayload(hider, hider.isExposedLive))
  }

  hiderPositionPayload(hider, isExposedLive) {
    const loc = hider.lastLocation
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

    if (hider.isExposedLive || wasExposed !== hider.isExposedLive) {
      // Live update while outside; one final boundary update when re-entering.
      // Always the full list so clients can replace their marker set wholesale.
      if (this.phase !== 'hiding') this.emitHiderSnapshot()
    }
  }

  /** Hunters are always public — stream their positions to the whole room. */
  broadcastHunterPositions() {
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

  handleLocation(player, { lat, lng, accuracy } = {}) {
    if (!isValidFix({ lat, lng, accuracy })) return
    const acc = typeof accuracy === 'number' ? accuracy : 0
    if (acc > GPS_MAX_REPORT) return // junk fix (city-level) — ignore

    // LOBBY: no game mechanics — but everyone sees everyone, so every
    // accepted fix rebroadcasts both roles to the whole room.
    if (this.status === 'lobby') {
      player.lastLocation = { lat, lng, accuracy: acc, at: Date.now(), quality: acc <= GPS_QUALITY_MAX }
      this.broadcastHunterPositions()
      this.io.to(this.code).emit('map:hider_positions', this.hiderListPayload())
      return
    }

    if (this.status !== 'active') return
    if (player.captured) return

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
    if (this.status !== 'active') throw new GameError('Game is not running')
    // A capture can only be reported by the hider themselves ("Found by" tap).
    if (requestedBy.id !== hiderId) throw new GameError('Only the hider can report being found')

    const hider = this.players.get(hiderId)
    const hunter = this.players.get(hunterId)
    if (!hider || hider.role !== 'hider') throw new GameError('Unknown hider')
    if (!hunter || hunter.role !== 'hunter') throw new GameError('Unknown hunter')
    if (hider.captured) throw new GameError('Hider was already captured')

    hider.captured = true
    hider.capturedBy = hunterId
    if (hider.inRange) {
      hider.inRange = false
      this.emitTo(hider, 'player:proximity_alert', { inRange: false, interval: this.settings.proximityBeepInterval })
    }

    const remaining = this.playersWithRole('hider').filter((p) => !p.captured).length
    if (remaining === 0) {
      // Single terminal broadcast: state (ended) + game:over, in that order.
      this.endGame('hunters', `All hiders found — last one caught by ${hunter.name}`)
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
    this.broadcastState()
    this.io.to(this.code).emit('game:over', { winner, reason })
  }

  /** Host extension: reset an ended match back to a fresh lobby. */
  resetToLobby(requestedBy) {
    this.assertHost(requestedBy)
    if (this.status !== 'ended') throw new GameError('Game has not ended yet')
    this.status = 'lobby'
    this.phase = 'main'
    this.hideRemaining = 0
    this.elapsed = 0
    this.timeRemaining = this.settings.gameDurationSeconds
    this.currentZoneRadius = this.settings.initialZoneRadius
    this.zoneCenter = { ...this.initialZoneCenter }
    for (const player of this.players.values()) {
      player.captured = false
      player.capturedBy = null
      player.inRange = false
      player.isExposedLive = false
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
  if (!isValidZoneCenter(zoneCenter)) throw new GameError('A valid zone center (lat/lng) is required')
  const code = generateRoomCode(rooms)
  const room = new Room(io, code, { hostName, role, zoneCenter, settings })
  rooms.set(code, room)
  return room
}

export function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase())
  if (!room) throw new GameError('Room not found — check the code')
  return room
}
