/**
 * End-to-end smoke test for the Manhunt game server.
 * Boots the real Socket.io server on a test port and plays a full match
 * with three connected clients (host, hunter, hider).
 *
 * Run: `npm test` inside backend/
 */
import { createApp } from '../src/index.js'
import { io } from 'socket.io-client'
import { applyShrink, distanceMeters } from '../src/rooms.js'

const PORT = 3999
const URL = `http://localhost:${PORT}`
const ZONE = { lat: 52.0, lng: 13.0 }

let passed = 0
let failed = 0

function assert(cond, label, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✔ ${label}`)
  } else {
    failed++
    console.error(`  ✘ ${label} ${extra}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'] })
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', reject)
    setTimeout(() => reject(new Error(`${name}: connect timeout`)), 4000)
  })
}

/** Await the next `event` — MUST be called before the triggering emit. */
function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs)
    socket.once(event, (payload) => {
      clearTimeout(t)
      resolve(payload)
    })
  })
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve)
  })
}

/** Await the next `event` matching `predicate` (e.g. the first main-phase tick). */
function onceWhere(socket, event, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`timeout waiting for "${event}" match`))
    }, timeoutMs)
    const handler = (payload) => {
      if (!predicate(payload)) return
      clearTimeout(timer)
      socket.off(event, handler)
      resolve(payload)
    }
    socket.on(event, handler)
  })
}

// ------------------------------------------------------------------ setup

const { httpServer } = createApp()
await new Promise((resolve) => httpServer.listen(PORT, resolve))
console.log(`\n▶ game server up on :${PORT}\n`)

// ---------------------------------------------------------------- pure helpers

assert(applyShrink(500, 25) === 375, 'applyShrink: 500m − 25% = 375m')
assert(applyShrink(25, 50) === 20, 'applyShrink: floor at MIN_ZONE_RADIUS (20m)')
const distCheck = Math.round(distanceMeters(ZONE, { lat: 52.001, lng: 13.0 }))
assert(distCheck === 111, 'turf distance: 0.001° lat ≈ 111m', `got ${distCheck}m`)

// ---------------------------------------------------------------- room:create

const host = await connect('host')
const created = await emitAck(host, 'room:create', {
  hostName: 'Alice',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: {
    gameDurationSeconds: 9999, // should clamp to 3600
    hidePhaseSeconds: 0, // no hiding phase in this match
    initialZoneRadius: 50,
    proximityDistanceMeters: 5,
    zoneShrinkInterval: 30,
  },
})
assert(created?.ok, 'room:create ack ok')
assert(created.roomState.status === 'lobby', 'room starts in lobby')
assert(created.roomState.settings.gameDurationSeconds === 3600, 'settings clamped to max range')
assert(created.roomState.settings.hidePhaseSeconds === 0, 'hide phase can be disabled')
assert(created.roomState.settings.initialZoneRadius === 50, 'valid settings kept')
assert(Object.keys(created.roomState.players).length === 1, 'host is first player')
assert(created.roomState.players[created.yourPlayerId].role === 'hunter', 'host role stored')
assert(created.roomState.players[created.yourPlayerId].lat === undefined, 'player serialization has no coordinates')
const code = created.roomState.code
assert(/^[A-Z2-9]{4}$/.test(code), `room code format ok (${code})`)

// ---------------------------------------------------------------- room:join

const hunter = await connect('hunter')
const joinedHunter = await emitAck(hunter, 'room:join', { roomCode: code, playerName: 'Bob', role: 'hunter' })
assert(joinedHunter?.ok, 'hunter join ok')
const hunterId = joinedHunter.yourPlayerId

const stateAfterJoin = once(host, 'room:state_changed')
const hider = await connect('hider')
const joinedHider = await emitAck(hider, 'room:join', { roomCode: code, playerName: 'Cara', role: 'hider' })
assert(joinedHider?.ok, 'hider join ok')
const hiderId = joinedHider.yourPlayerId

const joinState = await stateAfterJoin
assert(Object.keys(joinState.roomState.players).length === 3, 'room state broadcast to all (3 players)')

// duplicate name → error
const dup = await emitAck(hider, 'room:join', { roomCode: code, playerName: 'cara', role: 'hunter' })
assert(dup?.ok === false, 'duplicate (case-insensitive) name rejected')

// bad code → error event + failed ack
const ghost = await connect('ghost')
const ghostErr = once(ghost, 'room:error')
const badRoom = await emitAck(ghost, 'room:join', { roomCode: 'XXXX', playerName: 'Ghost' })
assert(badRoom?.ok === false, 'unknown room code rejected')
assert((await ghostErr).message, 'room:error emitted for unknown code')
ghost.disconnect()

// ---------------------------------------------------------------- role switch in lobby

const roleStatePromise = once(host, 'room:state_changed')
await emitAck(hunter, 'player:set_role', { roomCode: code, role: 'hider' })
const roleState = await roleStatePromise
assert(roleState.roomState.players[hunterId].role === 'hider', 'player can switch role in lobby')
// switch back so the capture scenario stays 1 hunter / 1 hider
const roleBackPromise = once(host, 'room:state_changed')
await emitAck(hunter, 'player:set_role', { roomCode: code, role: 'hunter' })
await roleBackPromise

// ---------------------------------------------------------------- lobby visibility

// In the lobby everyone sees everyone: fixes flow and both role lists are
// broadcast to the whole room. No game mechanics yet (no proximity beeps).
const lobbyHiderList = onceWhere(
  hunter,
  'map:hider_positions',
  (list) => list.some((h) => h.id === hiderId && h.lat === 52.0),
)
const lobbyHunterList = onceWhere(
  hider,
  'map:hunter_positions',
  (list) => list.some((h) => h.id === hunterId && h.lat === 52.0),
)
let lobbyBeep = false
once(hider, 'player:proximity_alert', 800).then(() => (lobbyBeep = true), () => {})
hunter.emit('player:location', { lat: 52.0, lng: 13.0, accuracy: 5 }) // populate the hunter's position first
hider.emit('player:location', { lat: 52.0, lng: 13.0, accuracy: 5 })
assert((await lobbyHiderList).length > 0, 'lobby: hunter sees hider positions')
assert((await lobbyHunterList).length > 0, 'lobby: hider sees hunter positions')
await sleep(900)
assert(lobbyBeep === false, 'no proximity alerts in the lobby')

// ---------------------------------------------------------------- lobby zone preview

// Changing initialZoneRadius must update the zone radius (map preview)
// immediately — currentZoneRadius mirrors the setting while in the lobby.
// NB: initialZoneRadius steps in 50 m increments.
const radiusState = once(hider, 'room:state_changed')
const radiusUpdate = await emitAck(host, 'room:update_settings', { roomCode: code, settings: { initialZoneRadius: 150 } })
assert(radiusUpdate?.ok, 'host can update initialZoneRadius')
const radiusRs = (await radiusState).roomState
assert(radiusRs.settings.initialZoneRadius === 150, 'settings update stored (initialZoneRadius)')
assert(radiusRs.currentZoneRadius === 150, 'lobby zone preview follows initialZoneRadius')
// Restore so the game:start assertions below stay valid.
const radiusBack = once(hider, 'room:state_changed')
await emitAck(host, 'room:update_settings', { roomCode: code, settings: { initialZoneRadius: 50 } })
assert((await radiusBack).roomState.currentZoneRadius === 50, 'lobby zone preview restored')

// ---------------------------------------------------------------- game:start

const errPromise = once(hunter, 'room:error')
const startByNonHost = await emitAck(hunter, 'game:start', { roomCode: code })
assert(startByNonHost?.ok === false, 'game:start by non-host rejected')
assert((await errPromise).message, 'room:error emitted for non-host start')

// register listeners BEFORE the start emits its initial payloads
const firstState = once(hider, 'room:state_changed')
const firstTick = once(hider, 'game:tick')
const hunterSnapshot = once(hunter, 'map:hider_positions')
const revealAtStart = once(hider, 'hiders:revealed')
const started = await emitAck(host, 'game:start', { roomCode: code })
assert(started?.ok, 'game:start (host) accepted')

assert((await firstState).roomState.status === 'active', 'status → active')

const tick = await firstTick
assert(tick.timeRemaining === 3600, `tick: full duration remaining (${tick.timeRemaining})`)
assert(tick.currentZoneRadius === 50, 'tick: zone radius = initial')
assert(tick.nextShrinkIn === 30, 'tick: next shrink driven by zoneShrinkInterval')
assert(tick.nextRevealIn === 60, 'tick: nextRevealIn driven by hiderRevealInterval')
assert(tick.phase === 'main', 'tick: phase = main (hide phase disabled)')

const snapshot = await hunterSnapshot
assert(Array.isArray(snapshot) && snapshot[0].id === hiderId, 'hunters received initial hider snapshot')
assert((await revealAtStart)?.at > 0, 'hiders receive hiders:revealed at hunt start')

const secondTick = await once(hider, 'game:tick')
assert(secondTick.timeRemaining === 3599, 'tick countdown decrements every second')
assert(secondTick.nextRevealIn === 59, 'reveal countdown decrements every second')

// The host (Alice) is a hunter too — one in-game fix so her lastLocation
// exists for the reset-list assertions further down.
host.emit('player:location', { lat: 52.0, lng: 13.0, accuracy: 5 })

// ---------------------------------------------------------------- exposure + proximity

// Hider stands just outside the 50m zone (≈ 111m north) → exposed live.
const exposed = once(hunter, 'map:hider_positions')
hider.emit('player:location', { lat: 52.001, lng: 13.0, accuracy: 5 })
const exposedPayload = await exposed
assert(exposedPayload[0].isExposedLive === true, 'hider outside zone → live exposure to hunters')
assert(exposedPayload[0].lat === 52.001, 'exposed payload carries live coordinates')

// Hunters are public: hiders see them live. (onceWhere: an earlier hunter's
// broadcast can be delivered late — match Ivy's entry specifically.)
const farHunters = onceWhere(
  hider,
  'map:hunter_positions',
  (list) => list.some((h) => h.id === hunterId && h.lat === 52.0),
)
hunter.emit('player:location', { lat: 52.0, lng: 13.0, accuracy: 5 })
assert((await farHunters).some((h) => h.id === hunterId), 'hiders receive live hunter positions')

// Hunter far away (> 5m) → no proximity alert for the hider.
let alertFiredWhileFar = false
once(hider, 'player:proximity_alert', 800).then(() => (alertFiredWhileFar = true), () => {})
await sleep(900)
assert(alertFiredWhileFar === false, 'no proximity alert while hunter is far away')

// Hunter moves within 5m of the hider → alert fires with configured interval.
const nearAlert = once(hider, 'player:proximity_alert')
hunter.emit('player:location', { lat: 52.001, lng: 13.0, accuracy: 5 })
const alert = await nearAlert
assert(alert.inRange === true, 'proximity alert inRange=true (turf distance ≤ 5m)')
assert(alert.interval === 30, 'alert carries host-configured beep interval')

// ---------------------------------------------------------------- GPS quality policy

// Reset: hunter leaves the radius with a quality fix → inRange flips back.
const farReset = once(hider, 'player:proximity_alert')
hunter.emit('player:location', { lat: 52.0, lng: 13.0, accuracy: 5 })
assert((await farReset).inRange === false, 'inRange resets when the hunter leaves the radius')

// Degraded fix (26–100 m): displayed, but must NOT trigger proximity…
hunter.emit('player:location', { lat: 52.001, lng: 13.0, accuracy: 60 })
let degradedAlert = false
once(hider, 'player:proximity_alert', 900).then(() => (degradedAlert = true), () => {})
await sleep(1000)
assert(degradedAlert === false, 'degraded fix (60 m error) does not trigger proximity alert')

// …and junk fixes (> 100 m) are dropped entirely: the hider must not see the
// hunter jump to the junk position.
let junkArrived = false
once(hider, 'map:hunter_positions', 800).then(() => (junkArrived = true), () => {})
hunter.emit('player:location', { lat: 55.0, lng: 13.0, accuracy: 5000 })
await sleep(900)
assert(junkArrived === false, 'junk fix (5 km error) is dropped entirely')

// A quality fix far away still updates hiders' hunter view.
const farUpdate = once(hider, 'map:hunter_positions')
hunter.emit('player:location', { lat: 52.0, lng: 13.0, accuracy: 10 })
assert((await farUpdate).some((h) => h.id === hunterId), 'quality fix updates hunter position for hiders')

// ---------------------------------------------------------------- capture → hunters win

const errPromise2 = once(hunter, 'room:error')
const captureByImpostor = await emitAck(hunter, 'hider:captured', { roomCode: code, hiderId, hunterId })
assert(captureByImpostor?.ok === false, 'capture report by non-hider rejected')
assert((await errPromise2).message, 'room:error emitted for impostor capture')

const over = once(host, 'game:over')
const endedState = once(hider, 'room:state_changed')
const captured = await emitAck(hider, 'hider:captured', { roomCode: code, hiderId, hunterId })
assert(captured?.ok, 'hider capture accepted')

const overPayload = await over
assert(overPayload.winner === 'hunters', 'hunters win when all hiders captured')
assert(typeof overPayload.reason === 'string' && overPayload.reason.length > 0, 'game:over carries a reason')
assert((await endedState).roomState.status === 'ended', 'status → ended')

// ---------------------------------------------------------------- leave after game end

// Leaving an ENDED room must remove the player for everyone — the game is
// over, there is nothing to reconnect to. (Only mid-game leaves keep the
// entry reconnectable.)
const leaveState = once(hider, 'room:state_changed')
const leftEnded = await emitAck(hunter, 'room:leave', { roomCode: code })
assert(leftEnded?.ok, 'room:leave accepted in an ended game')
assert((await leaveState).roomState.players[hunterId] === undefined, 'leaving an ended game removes the player from the list')

// ---------------------------------------------------------------- reset

const resetState = once(hider, 'room:state_changed')
// Alice (host/hunter) reports her position in the reopened lobby first — the
// other hunter left after the game, so she's the only hunter with a fix.
host.emit('player:location', { lat: 52.0, lng: 13.0, accuracy: 5 })
await sleep(200)
// The reopened lobby must include everyone's last known position right away —
// register the listeners BEFORE the reset emits them.
const resetHunterList = once(hider, 'map:hunter_positions')
const resetHiderList = once(hider, 'map:hider_positions')
const reset = await emitAck(host, 'game:reset', { roomCode: code })
assert(reset?.ok, 'host can reset an ended game (after a player left)')
assert((await resetState).roomState.status === 'lobby', 'status back to lobby')
assert((await once(hider, 'game:tick').catch(() => null)) === null, 'timers stopped after reset')
assert((await resetHunterList).length > 0, 'reset broadcasts hunter positions immediately')
assert((await resetHiderList).length > 0, 'reset broadcasts hider positions immediately')

// ---------------------------------------------------------------- hiding phase (room B)

const hostB = await connect('hostB')
const createdB = await emitAck(hostB, 'room:create', {
  hostName: 'Hank',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: {
    gameDurationSeconds: 300,
    hidePhaseSeconds: 5, // short head start so the test stays fast
    initialZoneRadius: 200,
    hiderRevealInterval: 60,
    proximityDistanceMeters: 20,
  },
})
assert(createdB?.ok, 'room B (with hide phase) created')
assert(createdB.roomState.settings.hidePhaseSeconds === 5, 'hidePhaseSeconds setting stored')
const codeB = createdB.roomState.code

const hunterB = await connect('hunterB')
const joinedB1 = await emitAck(hunterB, 'room:join', { roomCode: codeB, playerName: 'Ivy', role: 'hunter' })
const hunterBId = joinedB1.yourPlayerId
const hiderB = await connect('hiderB')
const joinedB2 = await emitAck(hiderB, 'room:join', { roomCode: codeB, playerName: 'Jon', role: 'hider' })
assert(joinedB2?.ok, 'hider joined room B')
const hiderBId = joinedB2.yourPlayerId
const hider2B = await connect('hider2B')
const joinedB3 = await emitAck(hider2B, 'room:join', { roomCode: codeB, playerName: 'Kai', role: 'hider' })
assert(joinedB3?.ok, 'second hider joined room B (team-visibility check)')
const hider2BId = joinedB3.yourPlayerId

// register all listeners BEFORE game:start emits its initial payloads
const stateB = once(hiderB, 'room:state_changed')
const firstTickB = once(hiderB, 'game:tick')
const mainTickB = onceWhere(hiderB, 'game:tick', (t) => t.phase === 'main')
const mainSnapshotB = once(hunterB, 'map:hider_positions', 10000)
const revealAtMainB = once(hiderB, 'hiders:revealed', 10000)
let revealedDuringHiding = false
once(hiderB, 'hiders:revealed', 2300).then(() => (revealedDuringHiding = true), () => {})
await emitAck(hostB, 'game:start', { roomCode: codeB })

assert((await stateB).roomState.phase === 'hiding', 'room state: phase = hiding')
const tickB = await firstTickB
assert(tickB.phase === 'hiding', 'tick: phase = hiding')
assert(tickB.hideRemaining > 0 && tickB.hideRemaining <= 5, `tick: hideRemaining counts down (${tickB.hideRemaining})`)

// While hiding, hider positions must NOT flow to hunters — even out of zone.
let leakedDuringHiding = false
once(hunterB, 'map:hider_positions', 1200).then(() => (leakedDuringHiding = true), () => {})
hiderB.emit('player:location', { lat: 52.01, lng: 13.0, accuracy: 5 }) // ≈1.1 km north → outside 200 m zone
await sleep(1300)
assert(leakedDuringHiding === false, 'no hider positions sent to hunters during hiding phase')

// While hiding, colocated players must not trip the proximity alert either.
let proximityDuringHiding = false
once(hiderB, 'player:proximity_alert', 900).then(() => (proximityDuringHiding = true), () => {})
hunterB.emit('player:location', { lat: 52.01, lng: 13.0, accuracy: 5 })
await sleep(1000)
assert(proximityDuringHiding === false, 'no proximity alerts during hiding phase')
assert(revealedDuringHiding === false, 'no hiders:revealed during hiding phase')

// After the head start the main phase begins: reveals start, duration intact.
const mainTick = await mainTickB
assert(mainTick.timeRemaining === 300, 'main phase: full game duration still remaining')
assert(mainTick.nextRevealIn === 60, 'main phase: reveal countdown driven by hiderRevealInterval')
const snapB = await mainSnapshotB
assert(
  snapB.some((h) => h.id === hiderBId && h.isExposedLive === true && h.lat === 52.01),
  'main phase: hider snapshot (with live exposure) flows to hunters',
)
assert((await revealAtMainB)?.at > 0, 'hiders:revealed fires when the hunt begins')

// Team visibility: a hider's fix pushes the full hider list to the HIDER role
// (hunters only get it via periodic reveals). Listener registered first.
const teamViewB = onceWhere(hider2B, 'map:hider_positions', (list) => list.some((h) => h.id === hiderBId))
hiderB.emit('player:location', { lat: 52.02, lng: 13.0, accuracy: 5 })
const teamList = await teamViewB
assert(
  teamList.some((h) => h.id === hiderBId && h.lat === 52.02),
  'hiders see other hiders live after a fix (team visibility)',
)

// Sanity: proximity alerts resume once the hunt is on (both colocated, quality fixes).
// hiderB's latest fix is 52.02 (from the team-visibility check above).
const postAlert = once(hiderB, 'player:proximity_alert')
hunterB.emit('player:location', { lat: 52.02, lng: 13.0, accuracy: 5 })
assert((await postAlert).inRange === true, 'proximity alerts resume in main phase')

// DEAD PIN: Jon walks into the zone (exposure flips off → boundary snapshot
// at 52.4999), then a quiet in-zone fix at 52.4998 that hunters do NOT
// receive (in-zone hiders only reach hunters via reveals).
hiderB.emit('player:location', { lat: 52.4999, lng: 13.0, accuracy: 5 })
hiderB.emit('player:location', { lat: 52.4998, lng: 13.0, accuracy: 5 })
await sleep(300)

// Capturing Jon must broadcast the found spot IMMEDIATELY — not at the next
// reveal. The 52.4998 fix was never broadcast, so only the capture-triggered
// snapshot can satisfy this predicate.
const deadPinNow = onceWhere(
  hunterB,
  'map:hider_positions',
  (list) => list.some((h) => h.id === hiderBId && h.lat === 52.4998),
)
const capturedB = await emitAck(hiderB, 'hider:captured', { roomCode: codeB, hiderId: hiderBId, hunterId: hunterBId })
assert(capturedB?.ok, 'second hider capture accepted (Jon)')
assert(
  (await deadPinNow).some((h) => h.id === hiderBId && h.lat === 52.4998),
  'capture broadcasts the found spot to hunters immediately',
)

// Post-capture fixes are dropped: the dead pin stays at the found spot.
hiderB.emit('player:location', { lat: 52.03, lng: 13.0, accuracy: 5 }) // post-capture move → must be ignored
const freezeList = onceWhere(
  hider2B,
  'map:hider_positions',
  (list) => list.some((h) => h.id === hider2BId) && list.some((h) => h.id === hiderBId),
)
hider2B.emit('player:location', { lat: 52.03, lng: 13.0, accuracy: 5 }) // Kai's fix triggers a team broadcast
const frozen = await freezeList
assert(
  frozen.some((h) => h.id === hiderBId && h.lat === 52.4998),
  'dead hider position frozen at capture spot (post-capture fixes dropped)',
)

hostB.disconnect()
hunterB.disconnect()
hiderB.disconnect()
hider2B.disconnect()

// ---------------------------------------------------------------- teardown

host.disconnect()
hunter.disconnect()
hider.disconnect()
httpServer.close()

console.log(`\n▶ ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
