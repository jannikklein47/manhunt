/**
 * End-to-end smoke test for the Manhunt game server.
 * Boots the real Socket.io server on a test port and plays a full match
 * with three connected clients (host, hunter, hider).
 *
 * Run: `npm test` inside backend/
 */
import { createApp } from '../src/index.js'
import { createReplayService } from '../src/replay/index.js'
import { summarizePlayers } from '../src/replay/stats.js'
import { io } from 'socket.io-client'
import { applyShrink, applyZoneShift, distanceMeters, Room } from '../src/rooms.js'

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

// Zone drift: distance uniform 0…½r, direction uniform — deterministic rng.
const noShift = applyZoneShift(ZONE, 500, () => 0)
assert(noShift.lat === ZONE.lat && noShift.lng === ZONE.lng, 'applyZoneShift: rng 0 → zone stays put')
const maxShift = applyZoneShift(ZONE, 500, () => 1)
const maxShiftDist = distanceMeters(ZONE, maxShift)
assert(Math.abs(maxShiftDist - 500) < 1, 'applyZoneShift: max drift = 1× radius', `got ${maxShiftDist}m`)
assert(maxShift.lat > ZONE.lat, 'applyZoneShift: bearing 360 → due north')

// shrinkZone wiring: one tick shrinks AND drifts; the pristine center is
// kept so rematches start back at the host-picked spot.
const fakeIo = { to: () => ({ emit: () => {} }) }
const driftRoom = new Room(fakeIo, 'DRIFT', {
  hostName: 'Zed',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: { initialZoneRadius: 100, zoneShrinkPercent: 10 },
})
driftRoom.shrinkZone()
assert(driftRoom.currentZoneRadius === 90, 'shrinkZone: radius shrinks')
assert(
  distanceMeters(ZONE, driftRoom.zoneCenter) <= 90,
  'shrinkZone: zone drifts at most 1× of the new radius',
)
assert(driftRoom.initialZoneCenter.lat === ZONE.lat, 'shrinkZone: pristine center kept for rematches')

// The drift is a host setting: zoneShiftEnabled: false shrinks without wandering.
const staticRoom = new Room(fakeIo, 'STATIC', {
  hostName: 'Zed',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: { initialZoneRadius: 100, zoneShrinkPercent: 10, zoneShiftEnabled: false },
})
assert(staticRoom.settings.zoneShiftEnabled === false, 'zoneShiftEnabled: false survives sanitization')
staticRoom.shrinkZone()
assert(staticRoom.currentZoneRadius === 90, 'zoneShiftEnabled: false still shrinks the radius')
assert(
  staticRoom.zoneCenter.lat === ZONE.lat && staticRoom.zoneCenter.lng === ZONE.lng,
  'zoneShiftEnabled: false → the zone never wanders',
)

// Exposure flips must reach the affected hider immediately (their own dot
// turns yellow and waves) — even for a stationary hider who sends no fresh
// GPS fix, e.g. when the shrinking zone drifts past them.
const sent = []
const recordingIo = {
  to: (id) => ({ emit: (event, payload) => sent.push({ id, event, payload }) }),
}
const pushRoom = new Room(recordingIo, 'PUSH', {
  hostName: 'Zed',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: { initialZoneRadius: 50, zoneShiftEnabled: false },
})
const pushHider = pushRoom.addPlayer(null, { name: 'Pat', role: 'hider' })
pushHider.connected = true
pushHider.socketId = 'sock-pat'
pushHider.lastLocation = { lat: 52.001, lng: 13.0, accuracy: 5, at: Date.now(), quality: true }
pushRoom.shrinkZone() // 111 m fix vs 50 m zone → exposure flips on
const pushed = sent.filter((s) => s.id === 'sock-pat' && s.event === 'map:hider_positions')
assert(
  pushed.length === 1,
  'shrink-driven exposure flip pushes the hider list to the hider instantly',
  `got ${pushed.length}`,
)
assert(pushed[0]?.payload?.[0]?.isExposedLive === true, 'pushed list flags the hider as exposed live')

// RE-ENTRY: when an exposed hider walks back into the zone, the hunters'
// pin must STAY where it is — frozen at the last live position they
// watched — instead of rewinding to an old periodic reveal spot.
const reSent = []
const reIo = { to: (id) => ({ emit: (event, payload) => reSent.push({ id, event, payload }) }) }
const reRoom = new Room(reIo, 'REENT', {
  hostName: 'Zed',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: { initialZoneRadius: 200, zoneShiftEnabled: false },
})
const reHunter = reRoom.players.get(reRoom.hostId)
reHunter.connected = true
reHunter.socketId = 'sock-hunter'
const reHider = reRoom.addPlayer(null, { name: 'Rey', role: 'hider' })
reHider.connected = true
reHider.socketId = 'sock-rey'
// A long-past periodic reveal froze his hunter-view spot at the zone center…
reHider.revealedLocation = { lat: 52.0, lng: 13.0, accuracy: 5, at: Date.now(), quality: true }
// …then he left the zone (≈334 m out) and streamed live at 52.003.
reHider.lastLocation = { lat: 52.003, lng: 13.0, accuracy: 5, at: Date.now(), quality: true }
reRoom.updateHiderExposure(reHider)
assert(reHider.isExposedLive === true, 're-entry setup: hider outside is exposed')

reSent.length = 0
// He steps back inside (≈111 m). The flip-off snapshot must keep the pin at
// the last watched position — NOT rewind it to the ancient 52.0 reveal.
reHider.lastLocation = { lat: 52.001, lng: 13.0, accuracy: 5, at: Date.now(), quality: true }
reRoom.updateHiderExposure(reHider)
assert(reHider.isExposedLive === false, 're-entry: hider inside is hidden again')
const reSnapshots = reSent.filter((s) => s.id === 'sock-hunter' && s.event === 'map:hider_positions')
const reEntry = reSnapshots.at(-1)?.payload?.find((h) => h.id === reHider.id)
assert(reEntry?.lat === 52.001, 're-entry keeps the pin at the last watched position', `got ${reEntry?.lat}`)
assert(reEntry?.isExposedLive === false, 're-entry snapshot flips the live flag off')
let worstRatio = 0
let prevCenter = driftRoom.zoneCenter
for (let i = 0; i < 50; i++) {
  driftRoom.shrinkZone()
  worstRatio = Math.max(
    worstRatio,
    distanceMeters(prevCenter, driftRoom.zoneCenter) / driftRoom.currentZoneRadius,
  )
  prevCenter = driftRoom.zoneCenter
}
assert(
  worstRatio <= 1.0,
  'shrinkZone: drift ≤ 1× radius per tick (50 ticks)',
  `worst ${(worstRatio * 100).toFixed(1)}%`,
)

// ---------------------------------------------------------------- endgame phase

// Direct-Room tests (manual ticks, no real timers): the endgame is the last
// phase — the switch performs one classic shrink-and-move whose result is
// announced in advance as the pulsating yellow preview, hiders outside that
// zone are out, hunters go dark, and the zone then only shrinks per second.
const egSent = []
const egIo = { to: (id) => ({ emit: (event, payload) => egSent.push({ id, event, payload }) }) }
const EG_SETTINGS = {
  gameDurationSeconds: 180,
  hidePhaseSeconds: 0,
  initialZoneRadius: 100,
  zoneShrinkInterval: 30,
  zoneShrinkPercent: 10,
  zoneShiftEnabled: false,
  endgameEnabled: true,
  endgameDurationSeconds: 60,
  endgameMinZoneRadius: 20,
  hiderRevealInterval: 60,
  proximityDistanceMeters: 5,
  proximityBeepInterval: 5,
}
const egRoom = new Room(egIo, 'EG', {
  hostName: 'Eva',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: EG_SETTINGS,
})
assert(egRoom.settings.endgameEnabled === true, 'endgame: enabled by default')
assert(egRoom.settings.endgameMinZoneRadius === 20, 'endgameMinZoneRadius setting stored')
assert(egRoom.settings.endgameNoticeSeconds === 90, 'endgameNoticeSeconds default: 90 s of warning time')
const egHunter = egRoom.players.get(egRoom.hostId)
egHunter.connected = true
egHunter.socketId = 'sock-eg-hunter'
const egHiderIn = egRoom.addPlayer(null, { name: 'Ina', role: 'hider' })
egHiderIn.connected = true
egHiderIn.socketId = 'sock-eg-ina'
const egHiderOut = egRoom.addPlayer(null, { name: 'Ole', role: 'hider' })
egHiderOut.connected = true
egHiderOut.socketId = 'sock-eg-ole'
egHiderIn.lastLocation = { lat: 52.0, lng: 13.0, accuracy: 5, at: Date.now(), quality: true }
// Ole sits ≈111 m north — even in the best case (the coming zone drifting
// straight towards him by its full radius) he stays >53 m outside of it.
egHiderOut.lastLocation = { lat: 52.001, lng: 13.0, accuracy: 5, at: Date.now(), quality: true }

// Main-phase sweep (elapsed 1…179). Classic shrinks at 30/60/90 take the
// radius 100 → 73; at 90 the notice window (90 s) opens: the coming endgame
// zone is announced and every further classic shrink is suspended.
egRoom.status = 'active'
egRoom.phase = 'main'
egRoom.timeRemaining = 180
for (let i = 0; i < 89; i++) egRoom.tick()
assert(egRoom.endgameZone === null, 'no preview before the notice window opens')
egRoom.tick() // elapsed 90 — timeRemaining 90 = endgameNoticeSeconds
assert(
  egRoom.endgameZone?.radius === 66,
  'endgame preview announced when the notice window opens: the coming zone after one classic shrink',
  `radius ${egRoom.endgameZone?.radius}`,
)
assert(
  distanceMeters(egRoom.zoneCenter, egRoom.endgameZone) === 0,
  'preview center: drift disabled → the coming zone stays at the live center',
)
for (let i = 0; i < 89; i++) egRoom.tick()
assert(
  egRoom.currentZoneRadius === 73,
  'live zone stays put while the preview is up (classic shrinking suspended)',
)
const egPreviewState = egSent.filter((s) => s.event === 'room:state_changed').at(-1)?.payload?.roomState
assert(egPreviewState?.endgameZone?.radius === 66, 'endgame preview rides in room state (resync)')
assert(egPreviewState?.phase === 'main', 'preview is announced during the main phase')

// THE SWITCH: main time up — the announced coming zone becomes the real zone
// (classic shrink-and-move), hiders outside it are out.
const egPreview = { ...egRoom.endgameZone }
egSent.length = 0
egRoom.tick()
assert(egRoom.phase === 'endgame', 'endgame phase begins when the main time is up')
assert(egRoom.endgameRemaining === 60, 'endgame countdown starts at the configured length')
assert(
  egRoom.currentZoneRadius === egPreview.radius,
  'the switch performs the announced classic shrink',
)
assert(
  egRoom.zoneCenter.lat === egPreview.lat && egRoom.zoneCenter.lng === egPreview.lng,
  'the switch moves the zone to the announced spot',
)
assert(egRoom.endgameZone === null, 'the yellow preview circle comes down at the switch')
assert(egHiderOut.captured === true, 'hider outside the endgame zone is out at the switch')
assert(egHiderOut.capturedReason === 'endzone', 'endzone elimination carries its reason')
assert(egHiderOut.capturedBy === null, 'endzone elimination has no capturer')
assert(egHiderIn.captured === false, 'hider inside the endgame zone survives the switch')
assert(
  egSent.some((s) => s.id === 'sock-eg-ina' && s.event === 'map:hunter_positions' && s.payload.length === 0),
  'hunters go dark: hiders receive an empty hunter list at the switch',
)
assert(
  egSent.some((s) => s.id === 'sock-eg-ole' && s.event === 'map:hunter_positions' && s.payload.length === 0),
  'eliminated hider also loses the hunter pins',
)

// During the endgame a hunter fix must never reach the hiders anymore.
egSent.length = 0
egRoom.handleLocation(egHunter, { lat: egPreview.lat, lng: egPreview.lng, accuracy: 5 })
assert(
  egSent.every((s) => !(s.id === 'EG' && s.event === 'map:hunter_positions')),
  'hunter fixes are never broadcast room-wide during the endgame',
)
assert(
  egSent.some((s) => s.id === 'sock-eg-hunter' && s.event === 'map:hunter_positions'),
  'hunters still see each other during the endgame',
)

// During the endgame the classic shrink-and-move is suspended: the center
// never moves again and the radius only follows the per-second approach.
const egCenterAtSwitch = { ...egRoom.zoneCenter }
for (let i = 0; i < 30; i++) egRoom.tick()
assert(
  egRoom.zoneCenter.lat === egCenterAtSwitch.lat && egRoom.zoneCenter.lng === egCenterAtSwitch.lng,
  'classic shrink-and-move is suspended during the endgame (center frozen)',
)
assert(
  egRoom.currentZoneRadius < 66 && egRoom.currentZoneRadius >= 20,
  'endgame: the zone shrinks second by second toward the final radius',
  `radius ${egRoom.currentZoneRadius}`,
)
for (let i = 0; i < 30; i++) egRoom.tick()
assert(
  egRoom.currentZoneRadius === 20,
  'endgame zone reaches the configured final radius',
  `radius ${egRoom.currentZoneRadius}`,
)
assert(
  egRoom.endgameRemaining === 0 && egRoom.status === 'ended',
  'the match ends when the endgame countdown hits zero',
)
const egOver = egSent.find((s) => s.event === 'game:over')?.payload
assert(
  egOver?.winner === 'hiders' && /Endgame/.test(egOver?.reason || ''),
  'endgame end: surviving hiders win',
  JSON.stringify(egOver),
)

// The switch's classic MOVE: with drift enabled the announced center wanders
// up to the new radius away from the live zone — and is applied exactly.
const eg3Room = new Room(egIo, 'EG3', {
  hostName: 'Eva',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: { ...EG_SETTINGS, zoneShiftEnabled: true },
})
eg3Room.status = 'active'
eg3Room.phase = 'main'
eg3Room.timeRemaining = 180
for (let i = 0; i < 179; i++) eg3Room.tick()
const eg3Preview = { ...eg3Room.endgameZone }
const eg3CenterBefore = { ...eg3Room.zoneCenter }
assert(
  distanceMeters(eg3CenterBefore, eg3Preview) <= eg3Preview.radius,
  'preview center: drift rolls up to 1× the new radius away from the live zone',
  `got ${distanceMeters(eg3CenterBefore, eg3Preview)}m vs ${eg3Preview.radius}m`,
)
eg3Room.tick()
assert(
  eg3Room.zoneCenter.lat === eg3Preview.lat && eg3Room.zoneCenter.lng === eg3Preview.lng,
  'the switch moves the zone to the announced spot (drift applied)',
)
assert(
  eg3Room.currentZoneRadius === eg3Preview.radius,
  'the switch performs the announced classic shrink (drift case)',
)

// Chip honesty BEFORE the announcement: when the notice window would open
// before the next shrink tick, that shrink is suspended already — the tick
// payload reports `nextShrinkIn: null` from that moment on, so the UI hides
// the „Schrumpfen in“ chip instead of counting down to a no-op shrink.
// Scenario: next shrink in 30 s, 10 s later the notice appears → hidden now.
// (Window: timeRemaining ≤ 80 → elapsed 100; shrinks at 30/60/90 still run.)
const eg4Room = new Room(egIo, 'EG4', {
  hostName: 'Eva',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: { ...EG_SETTINGS, endgameNoticeSeconds: 80 },
})
eg4Room.status = 'active'
eg4Room.phase = 'main'
eg4Room.timeRemaining = 180
const eg4Tick = () => egSent.filter((s) => s.id === 'EG4' && s.event === 'game:tick').at(-1)?.payload
egSent.length = 0
for (let i = 0; i < 85; i++) eg4Room.tick() // elapsed 85 — shrink in 5 s, window in 15 s
assert(
  eg4Tick()?.nextShrinkIn === 5,
  'chip: the next shrink still runs when the notice window opens after it',
  `nextShrinkIn ${eg4Tick()?.nextShrinkIn}`,
)
assert(
  eg4Tick()?.endgameNoticeIn === 15,
  'chip: the notice countdown runs in parallel (endgameNoticeIn)',
  `endgameNoticeIn ${eg4Tick()?.endgameNoticeIn}`,
)
for (let i = 0; i < 6; i++) eg4Room.tick() // elapsed 91 — the elapsed-90 shrink ran, window in 9 s
assert(eg4Room.endgameZone === null, 'chip: the preview is not up yet while the shrink is suspended')
assert(
  eg4Tick()?.nextShrinkIn === null,
  'chip: the upcoming notice window suspends the next shrink — nextShrinkIn is null already',
  `nextShrinkIn ${eg4Tick()?.nextShrinkIn}`,
)
assert(
  eg4Tick()?.endgameNoticeIn === 9,
  'chip: in the suspended gap the tick counts down to the notice instead',
  `endgameNoticeIn ${eg4Tick()?.endgameNoticeIn}`,
)
for (let i = 0; i < 9; i++) eg4Room.tick() // elapsed 100 — the notice window opens
assert(
  eg4Room.endgameZone?.radius === 66,
  'chip: the window opens on schedule and the preview appears',
  `radius ${eg4Room.endgameZone?.radius}`,
)
assert(
  eg4Tick()?.endgameNoticeIn === null,
  'chip: with the preview up, the notice countdown hands over to the Endgame-in chip',
  `endgameNoticeIn ${eg4Tick()?.endgameNoticeIn}`,
)
assert(
  eg4Tick()?.nextShrinkIn === null,
  'chip: once announced, nextShrinkIn stays null through the endgame',
)

// Endzone wipe-out: if the switch eliminates the LAST hiders, the match ends
// right away — exactly like a reported capture of the final hider would.
const eg2Room = new Room(egIo, 'EG2', {
  hostName: 'Eva',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: EG_SETTINGS,
})
const eg2Hider = eg2Room.addPlayer(null, { name: 'Ole', role: 'hider' })
eg2Hider.connected = true
eg2Hider.socketId = 'sock-eg2-ole'
// ≈111 m north — outside the zone at every point of this match.
eg2Hider.lastLocation = { lat: 52.001, lng: 13.0, accuracy: 5, at: Date.now(), quality: true }
eg2Room.status = 'active'
eg2Room.phase = 'main'
eg2Room.timeRemaining = 180
egSent.length = 0
for (let i = 0; i < 180; i++) eg2Room.tick()
assert(eg2Room.status === 'ended', 'endzone wipe-out: the match ends at the switch')
const eg2Over = egSent.find((s) => s.event === 'game:over')?.payload
assert(
  eg2Over?.winner === 'hunters' && /Endzone/.test(eg2Over?.reason || ''),
  'endzone wipe-out: hunters win immediately',
  JSON.stringify(eg2Over),
)

// Endgame OFF: no preview, and time-up ends the match like it always did.
const egOffRoom = new Room(egIo, 'EGOFF', {
  hostName: 'Zed',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: {
    gameDurationSeconds: 180,
    endgameEnabled: false,
    endgameDurationSeconds: 9999,
    endgameMinZoneRadius: 5,
    endgameNoticeSeconds: 3,
  },
})
assert(egOffRoom.settings.endgameEnabled === false, 'endgame can be disabled')
assert(egOffRoom.settings.endgameDurationSeconds === 1200, 'endgameDurationSeconds clamped to max')
assert(egOffRoom.settings.endgameMinZoneRadius === 20, 'endgameMinZoneRadius clamped to min')
assert(egOffRoom.settings.endgameNoticeSeconds === 10, 'endgameNoticeSeconds clamped to min')
egOffRoom.status = 'active'
egOffRoom.phase = 'main'
egOffRoom.elapsed = 179
egOffRoom.tick()
assert(egOffRoom.status === 'ended', 'endgame disabled: time-up ends the match as before')
assert(egOffRoom.phase === 'main' && egOffRoom.endgameZone === null, 'endgame disabled: no endgame phase, no preview')

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

// zoneShiftEnabled: boolean setting round-trips through the socket API.
const shiftState = once(hider, 'room:state_changed')
const shiftUpdate = await emitAck(host, 'room:update_settings', {
  roomCode: code,
  settings: { zoneShiftEnabled: false },
})
assert(shiftUpdate?.ok, 'host can update zoneShiftEnabled')
assert((await shiftState).roomState.settings.zoneShiftEnabled === false, 'zoneShiftEnabled: false stored')
const shiftBack = once(hider, 'room:state_changed')
await emitAck(host, 'room:update_settings', { roomCode: code, settings: { zoneShiftEnabled: true } })
assert((await shiftBack).roomState.settings.zoneShiftEnabled === true, 'zoneShiftEnabled restored')

// endgame settings round-trip through the socket API (sanitized server-side).
const egState = once(hider, 'room:state_changed')
const egUpdate = await emitAck(host, 'room:update_settings', {
  roomCode: code,
  settings: { endgameDurationSeconds: 9999, endgameMinZoneRadius: 3, endgameNoticeSeconds: 9999 },
})
assert(egUpdate?.ok, 'host can update endgame settings')
const egSettingsRs = (await egState).roomState.settings
assert(
  egSettingsRs.endgameDurationSeconds === 1200 &&
    egSettingsRs.endgameMinZoneRadius === 20 &&
    egSettingsRs.endgameNoticeSeconds === 600,
  'endgame settings clamped server-side',
)
const egBack = once(hider, 'room:state_changed')
await emitAck(host, 'room:update_settings', {
  roomCode: code,
  settings: { endgameDurationSeconds: 300, endgameMinZoneRadius: 100, endgameNoticeSeconds: 90 },
})
assert((await egBack).roomState.settings.endgameMinZoneRadius === 100, 'endgame settings restored')

// ------------------------------------------------------- move the zone center

// The host can re-place the zone center in the lobby — even after the
// create screen — and the new center is broadcast to everyone.
const movedState = once(hider, 'room:state_changed')
const moved = await emitAck(host, 'room:set_zone_center', {
  roomCode: code,
  zoneCenter: { lat: 52.004, lng: 13.004 },
})
assert(moved?.ok, 'host can move the zone center in the lobby')
assert((await movedState).roomState.zoneCenter.lat === 52.004, 'new zone center broadcast to the room')
// Non-hosts cannot move the zone.
const centerDenied = await emitAck(hider, 'room:set_zone_center', {
  roomCode: code,
  zoneCenter: { lat: 52.008, lng: 13.008 },
})
assert(centerDenied?.ok === false, 'zone center move by non-host rejected')
// Restore so the game:start tick assertions (ZONE) stay valid.
const centerBack = once(hider, 'room:state_changed')
await emitAck(host, 'room:set_zone_center', { roomCode: code, zoneCenter: ZONE })
assert((await centerBack).roomState.zoneCenter.lat === ZONE.lat, 'zone center restored')

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
assert(tick.zoneCenter && tick.zoneCenter.lat === ZONE.lat, 'tick carries the zone center')
// …and the center is locked once the match is running.
const centerLocked = await emitAck(host, 'room:set_zone_center', {
  roomCode: code,
  zoneCenter: { lat: 52.5, lng: 13.5 },
})
assert(centerLocked?.ok === false, 'zone center is locked once the game started')

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
const endedRs = (await endedState).roomState
assert(endedRs.status === 'ended', 'status → ended')
assert(endedRs.players[hiderId]?.capturedReason === 'caught', 'reported capture carries the caught reason')

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

// REGRESSION (over-reveal): Kai fixes his position INSIDE the zone, then
// exposed Jon sends another fix. The exposure-driven hunter snapshot must
// carry Jon's live fix but NOT Kai's current one — Kai is not exposed and
// no periodic reveal has included him yet, so his hunter-view coords stay
// null (with the over-reveal bug they would leak as his 52.0005 fix).
hider2B.emit('player:location', { lat: 52.0005, lng: 13.0, accuracy: 5 })
const noOverReveal = onceWhere(
  hunterB,
  'map:hider_positions',
  (list) => list.some((h) => h.id === hiderBId && h.lat === 52.03),
)
hiderB.emit('player:location', { lat: 52.03, lng: 13.0, accuracy: 5 })
const overRevealList = await noOverReveal
assert(
  overRevealList.find((h) => h.id === hider2BId)?.lat === null,
  'exposure snapshot keeps hidden hiders at their last reveal position',
)

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

// ---------------------------------------------------------------- rejoin (room C)
// SEAMLESS REJOIN: a dropped socket (no page reload) must resume mid-match
// with the same player id/role, receive a full data resync (position lists +
// proximity state), and a rejoin after the game has ended must see the final
// result — but no position lists (they are wiped at 'ended').

const hostC = await connect('hostC')
const createdC = await emitAck(hostC, 'room:create', {
  hostName: 'Zed',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: {
    gameDurationSeconds: 300,
    hidePhaseSeconds: 0, // straight into the main phase
    initialZoneRadius: 200,
    zoneShiftEnabled: false, // deterministic zone for the exposure math
  },
})
assert(createdC?.ok, 'room C created')
const codeC = createdC.roomState.code

const hunterC = await connect('hunterC')
const joinedC1 = await emitAck(hunterC, 'room:join', { roomCode: codeC, playerName: 'Ivy', role: 'hunter' })
const hunterCId = joinedC1.yourPlayerId
const hiderC = await connect('hiderC')
const joinedC2 = await emitAck(hiderC, 'room:join', { roomCode: codeC, playerName: 'Jon', role: 'hider' })
const hiderCId = joinedC2.yourPlayerId
assert(joinedC2?.ok, 'hider joined room C')

await emitAck(hostC, 'game:start', { roomCode: codeC })
hunterC.emit('player:location', { lat: 52.0, lng: 13.0, accuracy: 5 })
await sleep(200)

// The hider's socket drops WITHOUT a page reload — the store's auto-rejoin
// path. A fresh socket joins by name only (no role!) and must get the same
// player entry back plus a full resync of the data it missed while offline.
hiderC.disconnect()
await sleep(50)
const hiderC2 = await connect('hiderC2')
const resyncHunters = once(hiderC2, 'map:hunter_positions')
const resyncHiders = once(hiderC2, 'map:hider_positions')
const resyncProximity = once(hiderC2, 'player:proximity_alert')
const rejoinedC = await emitAck(hiderC2, 'room:join', { roomCode: codeC, playerName: 'Jon' })
assert(rejoinedC?.ok, 'rejoin by name (no role) accepted')
assert(rejoinedC.yourPlayerId === hiderCId, 'rejoin keeps the same player id')
assert(
  rejoinedC.roomState.players[hiderCId]?.role === 'hider',
  'rejoin keeps the server-side role (no role sent)',
)
assert(rejoinedC.roomState.players[hiderCId]?.connected === true, 'rejoined player is connected again')
const huntersResync = await resyncHunters
assert(huntersResync.some((h) => h.id === hunterCId), 'resync: hunter list arrives for the hider')
const hidersResync = await resyncHiders
assert(hidersResync.some((h) => h.id === hiderCId), 'resync: hider team list arrives')
assert((await resyncProximity).inRange === false, 'resync: current proximity state arrives')

// Mid-match exposure still works after the rejoin: a fix far outside the
// 200 m zone exposes Jon — the live position reaches the hunter, and the
// flip reaches the hider himself (own dot turns yellow + waves).
const exposedToHunter = onceWhere(
  hunterC,
  'map:hider_positions',
  (list) => list.some((h) => h.id === hiderCId && h.lat === 52.005),
)
const exposedToSelf = onceWhere(
  hiderC2,
  'map:hider_positions',
  (list) => list.some((h) => h.id === hiderCId && h.isExposedLive === true),
)
hiderC2.emit('player:location', { lat: 52.005, lng: 13.0, accuracy: 5 })
assert((await exposedToHunter).some((h) => h.id === hiderCId && h.isExposedLive === true), 'exposure reaches the hunter after rejoin')
assert((await exposedToSelf) !== null, 'exposure flip reaches the hider himself after rejoin')

// The single hider is captured → the game ends. Then a rejoin at 'ended'
// must deliver the final result in room state — and NO position lists
// (sendResync is silent once the game is over).
const gameOverC = once(hunterC, 'game:over')
const capturedC = await emitAck(hiderC2, 'hider:captured', { roomCode: codeC, hiderId: hiderCId, hunterId: hunterCId })
assert(capturedC?.ok, 'capture accepted after rejoin')
const overC = await gameOverC
assert(overC?.winner === 'hunters' && typeof overC.reason === 'string', 'game:over broadcast after rejoin capture')

hiderC2.disconnect()
await sleep(50)
const hiderC3 = await connect('hiderC3')
const noResyncHunters = once(hiderC3, 'map:hunter_positions').then(
  () => true,
  () => false,
)
const noResyncHiders = once(hiderC3, 'map:hider_positions').then(
  () => true,
  () => false,
)
const rejoinedEnded = await emitAck(hiderC3, 'room:join', { roomCode: codeC, playerName: 'Jon' })
assert(rejoinedEnded?.ok, 'rejoin after game end accepted')
assert(rejoinedEnded.roomState.status === 'ended', 'rejoin at ended: status delivered')
assert(rejoinedEnded.roomState.players[hiderCId]?.captured === true, 'rejoin at ended: captured state kept')
assert(rejoinedEnded.roomState.gameOver?.winner === 'hunters', 'rejoin at ended: gameOver result rides in room state')
await sleep(300)
assert((await noResyncHunters) === false, 'no hunter list resync at ended')
assert((await noResyncHiders) === false, 'no hider list resync at ended')

hostC.disconnect()
hunterC.disconnect()
hiderC3.disconnect()

// -------------------------------------------------------------- match replay

// In-memory store double with the same interface as the Postgres store —
// used to test the recorder without a database and to serve the REST API.
function memoryStore() {
  return {
    matches: new Map(),
    events: new Map(),
    statsByMatch: new Map(), // matchId → [{ playerId, name, … }]
    async init() {},
    async insertMatch(m) {
      this.matches.set(m.id, { ...m, endedAt: null, winner: null, reason: null, eventCount: 0 })
    },
    async insertEvents(matchId, rows) {
      const list = this.events.get(matchId) ?? []
      list.push(...rows.map((r) => ({ ...r })))
      this.events.set(matchId, list)
    },
    async finishMatch(matchId, patch) {
      const m = this.matches.get(matchId)
      if (m) Object.assign(m, patch)
    },
    async insertPlayerStats(matchId, rows) {
      this.statsByMatch.set(matchId, rows.map((r) => ({ ...r })))
    },
    async matchesWithoutStats() {
      return [...this.matches.values()]
        .filter((m) => m.endedAt && !(this.statsByMatch.get(m.id)?.length > 0))
        .map((m) => m.id)
    },
    async leaderboard({ limit = 100 } = {}) {
      const byName = new Map()
      for (const rows of this.statsByMatch.values()) {
        for (const r of rows) {
          const key = String(r.name ?? '').trim().toLowerCase()
          const agg =
            byName.get(key) ??
            byName
              .set(key, {
                key,
                name: String(r.name ?? '').trim(),
                matches: 0,
                wins: 0,
                hiderMatches: 0,
                hunterMatches: 0,
                timesCaught: 0,
                timesSurvived: 0,
                captures: 0,
                catchPctSum: 0,
                exposures: 0,
                distanceM: 0,
                survivedPcts: [],
              })
              .get(key)
          agg.matches++
          if (r.won) agg.wins++
          if (r.role === 'hider') {
            agg.hiderMatches++
            agg.survivedPcts.push(r.survivedPct ?? 0)
          } else {
            agg.hunterMatches++
          }
          if (r.role === 'hider' && r.captured) agg.timesCaught++
          if (r.role === 'hider' && r.survived) agg.timesSurvived++
          agg.captures += r.captures ?? 0
          agg.catchPctSum += r.catchPctSum ?? 0
          agg.exposures += r.exposures ?? 0
          agg.distanceM += r.distanceM ?? 0
        }
      }
      return [...byName.values()]
        .map(({ survivedPcts, catchPctSum, captures, ...a }) => ({
          ...a,
          captures,
          avgSurvivedPct: survivedPcts.length
            ? survivedPcts.reduce((s, p) => s + p, 0) / survivedPcts.length
            : null,
          avgCatchPct: captures > 0 ? catchPctSum / captures : null,
        }))
        .sort((a, b) => b.wins - a.wins || b.matches - a.matches)
        .slice(0, limit)
    },
    async playerStats(name) {
      const key = String(name ?? '').trim().toLowerCase()
      const rows = []
      for (const [matchId, list] of this.statsByMatch) {
        const match = this.matches.get(matchId) ?? {}
        for (const r of list) {
          if (String(r.name ?? '').trim().toLowerCase() !== key) continue
          rows.push({
            id: matchId,
            lobbyCode: match.lobbyCode,
            startedAt: match.startedAt,
            winner: match.winner,
            role: r.role,
            captured: r.captured,
            survived: r.survived,
            won: r.won,
            captures: r.captures,
            exposures: r.exposures,
            distanceM: r.distanceM,
          })
        }
      }
      if (!rows.length) return null
      const stats = rows.reduce(
        (a, r) => {
          a.matches++
          if (r.won) a.wins++
          if (r.role === 'hider') {
            a.hiderMatches++
            a.survivedPcts.push(r.survivedPct ?? 0)
          } else {
            a.hunterMatches++
          }
          if (r.role === 'hider' && r.captured) a.timesCaught++
          if (r.role === 'hider' && r.survived) a.timesSurvived++
          a.captures += r.captures ?? 0
          a.catchPctSum += r.catchPctSum ?? 0
          a.exposures += r.exposures ?? 0
          a.distanceM += r.distanceM ?? 0
          return a
        },
        {
          matches: 0,
          wins: 0,
          hiderMatches: 0,
          hunterMatches: 0,
          timesCaught: 0,
          timesSurvived: 0,
          captures: 0,
          catchPctSum: 0,
          exposures: 0,
          distanceM: 0,
          survivedPcts: [],
        },
      )
      const { survivedPcts, catchPctSum, captures, ...rest } = stats
      return {
        name: rows[0].name ?? key,
        stats: {
          ...rest,
          captures,
          avgSurvivedPct: survivedPcts.length
            ? survivedPcts.reduce((s, p) => s + p, 0) / survivedPcts.length
            : null,
          avgCatchPct: captures > 0 ? catchPctSum / captures : null,
        },
        matches: rows.sort((a, b) => b.startedAt - a.startedAt),
      }
    },
    async listMatches({ limit = 100 } = {}) {
      return [...this.matches.values()]
        .slice(0, limit)
        .map((m) => ({ ...m, playerCount: (m.players ?? []).length }))
    },
    async getMatch(id) {
      return this.matches.get(id) ?? null
    },
    async getEvents(id) {
      return this.events.get(id) ?? []
    },
  }
}

// Disabled replay (no DATABASE_URL): pure passthrough, the game server is
// untouched.

// ---- player stats derivation (pure, synthetic stream over 100 s of match)

{
  const ev = (ms, event, payload) => ({ at: new Date(ms).toISOString(), event, payload })
  const events = [
    ev(0, 'room:state_changed', {
      roomState: {
        status: 'active',
        players: {
          h: { id: 'h', name: 'Hank', role: 'hunter' },
          a: { id: 'a', name: 'Anna', role: 'hider' },
          b: { id: 'b', name: 'Ben', role: 'hider' },
        },
      },
    }),
    ev(10_000, 'player:location', { playerId: 'a', lat: 52, lng: 13 }),
    ev(20_000, 'player:location', { playerId: 'a', lat: 52.001, lng: 13 }),
    ev(30_000, 'map:hider_positions', [
      { id: 'a', isExposedLive: true },
      { id: 'b', isExposedLive: false },
    ]),
    ev(40_000, 'room:state_changed', {
      roomState: { players: { a: { id: 'a', name: 'Anna', role: 'hider', captured: true, capturedBy: 'h', capturedReason: 'reported' } } },
    }),
    ev(60_000, 'map:hider_positions', [
      { id: 'a', isExposedLive: false },
      { id: 'b', isExposedLive: true },
    ]),
    ev(70_000, 'room:state_changed', {
      roomState: { players: { b: { id: 'b', name: 'Ben', role: 'hider', captured: true, capturedBy: 'h', capturedReason: 'reported' } } },
    }),
    ev(100_000, 'game:over', { winner: 'hunters', reason: 'Alle Verstecker gefangen' }),
  ]
  const rows = summarizePlayers(events)
  const byId = Object.fromEntries(rows.map((r) => [r.id ?? r.playerId, r]))
  const anna = rows.find((r) => r.name === 'Anna')
  const ben = rows.find((r) => r.name === 'Ben')
  const hank = rows.find((r) => r.name === 'Hank')
  assert(anna?.captured && anna?.capturedReason === 'reported' && anna?.survivedPct === 40, 'stats: hider survival % = capture moment / match time', JSON.stringify(anna))
  assert(anna?.exposures === 1, 'stats: exposure counted once across flag flips')
  assert(ben?.survivedPct === 70 && ben?.exposures === 1, 'stats: second hider survival %')
  assert(hank?.captures === 2 && hank?.catchPctSum === 110, 'stats: hunter catch % sums per catch (40 + 70)', JSON.stringify(hank))
  assert(hank?.survivedPct === 0, 'stats: no survival % for hunters')
  assert(anna?.fixCount === 2 && anna?.distanceM > 100 && anna?.distanceM < 120, 'stats: distance summed over consecutive fixes')
}

const noOp = createReplayService({ store: null })
assert(noOp.enabled === false, 'replay: disabled without a store')
assert(noOp.wrapIo(fakeIo) === fakeIo, 'replay: disabled → io passes through unwrapped')
noOp.recordFix('RR', 'p1', { lat: 1, lng: 2 })
assert(true, 'replay: disabled → recordFix is a safe no-op')

// Recorder lifecycle, driven exactly like in production: wrapped io emits
// the room broadcasts, fixes come in through recordFix.
const mem = memoryStore()
const roomsBySocket = new Map([['sock-1', 'RR']])
const svc = createReplayService({
  store: mem,
  resolveSocketRoom: (id) => roomsBySocket.get(id) ?? null,
})
assert(svc.enabled === true, 'replay: enabled with a store')
const rrSent = []
const wrapped = svc.wrapIo({ to: (t) => ({ emit: (e, p) => rrSent.push({ t, e, p }) }) })

// Lobby broadcasts open no match — the log starts with the game.
wrapped
  .to('RR')
  .emit('room:state_changed', { roomState: { code: 'RR', status: 'lobby', settings: {}, players: {} } })
assert(mem.matches.size === 0, 'replay: lobby broadcasts open no match')
assert(rrSent.length === 1, 'replay: emits pass through to the room unchanged')

// First active state broadcast opens the match: id, code, settings, roster.
const RR_STATE = {
  code: 'RR',
  hostId: 'h1',
  status: 'active',
  phase: 'main',
  settings: { gameDurationSeconds: 600, zoneShrinkInterval: 30 },
  players: {
    h1: { id: 'h1', name: 'Eva', role: 'hunter' },
    h2: { id: 'h2', name: 'Ina', role: 'hider' },
  },
}
wrapped.to('RR').emit('room:state_changed', { roomState: RR_STATE })
await svc.flushAll()
assert(mem.matches.size === 1, 'replay: the first active broadcast opens the match')
const rrMatch = [...mem.matches.values()][0]
assert(rrMatch.lobbyCode === 'RR', 'replay: match saved with its lobby code', JSON.stringify(rrMatch))
assert(typeof rrMatch.id === 'string' && rrMatch.id.length === 36, 'replay: match saved with a uuid id')
assert(rrMatch.startedAt instanceof Date || typeof rrMatch.startedAt === 'string', 'replay: match saved with a date')
assert(rrMatch.settings?.gameDurationSeconds === 600, 'replay: settings snapshot stored')
assert(rrMatch.players?.length === 2 && rrMatch.players[1].role === 'hider', 'replay: roster snapshot stored')

// Events get a gapless per-match seq in arrival order, including inbound
// GPS fixes and EVERY socket-scoped action (no whitelist — the log is the
// full verbatim stream, also of events no viewer consumes today).
wrapped.to('RR').emit('game:tick', { timeRemaining: 599 })
svc.recordFix('RR', 'h2', { lat: 52.0, lng: 13.0, accuracy: 8 })
wrapped.to('sock-1').emit('player:proximity_alert', { inRange: true, interval: 5 })
wrapped.to('sock-1').emit('map:hider_positions', [{ id: 'h2', isExposedLive: false }])
wrapped.to('sock-1').emit('map:hunter_positions', [{ id: 'h1' }])
wrapped.to('OTHER').emit('game:tick', { timeRemaining: 1 }) // another room: no recording
await svc.flushAll()
const rrEvents = mem.events.get(rrMatch.id) ?? []
assert(
  JSON.stringify(rrEvents.map((e) => e.seq)) === '[1,2,3,4,5,6]',
  'replay: events logged with gapless seq in arrival order',
  JSON.stringify(rrEvents.map((e) => e.seq)),
)
assert(
  JSON.stringify(rrEvents.map((e) => e.event)) ===
    '["room:state_changed","game:tick","player:location","player:proximity_alert","map:hider_positions","map:hunter_positions"]',
  'replay: fixes and every socket-scoped action ride the log, foreign rooms do not',
  JSON.stringify(rrEvents.map((e) => e.event)),
)
assert(
  rrEvents[2].payload.playerId === 'h2' && rrEvents[2].payload.lat === 52.0,
  'replay: location event carries player id and fix',
)
assert(rrEvents.every((e) => e.at), 'replay: every event carries a timestamp')

// Role fan-out dedupe: the same payload emitted to N sockets collapses into
// one row — until the payload changes (an exposure flip, say).
wrapped.to('sock-1').emit('map:hider_positions', [{ id: 'h2', isExposedLive: false }])
await svc.flushAll()
assert((mem.events.get(rrMatch.id) ?? []).length === 6, 'replay: identical scoped fan-out copies collapse')
wrapped.to('sock-1').emit('map:hider_positions', [{ id: 'h2', isExposedLive: true }])
await svc.flushAll()
assert((mem.events.get(rrMatch.id) ?? []).length === 7, 'replay: changed scoped payloads are logged')

// game:over seals the match: result + end date written, log closed.
wrapped.to('RR').emit('room:state_changed', { roomState: { ...RR_STATE, status: 'ended' } })
wrapped.to('RR').emit('game:over', { winner: 'hunters', reason: 'Alle Verstecker gefunden' })
await sleep(100)
const rrDone = mem.matches.get(rrMatch.id)
assert(rrDone.winner === 'hunters' && rrDone.reason === 'Alle Verstecker gefunden', 'replay: game:over seals the match with its result')
assert(rrDone.endedAt && rrDone.eventCount === 9, 'replay: end date + event count written', `count ${rrDone?.eventCount}`)
wrapped.to('RR').emit('game:tick', { timeRemaining: 0 })
assert((mem.events.get(rrMatch.id) ?? []).length === 9, 'replay: nothing is logged after the match ended')

// Player stats derived at seal time: roles, win, exposure flips, GPS distance.
const rrStats = mem.statsByMatch.get(rrMatch.id) ?? []
assert(rrStats.length === 2, 'replay: player stats stored for every player', JSON.stringify(rrStats))
const eva = rrStats.find((p) => p.name === 'Eva')
const ina = rrStats.find((p) => p.name === 'Ina')
assert(eva?.role === 'hunter' && eva?.won === true, 'replay: winning hunter flagged', JSON.stringify(eva))
assert(
  ina?.role === 'hider' && ina?.captured === false && ina?.survived === true && ina?.won === false,
  'replay: surviving hider on the losing side',
)
assert(ina?.exposures === 1, 'replay: exposure flip counted exactly once', String(ina?.exposures))
assert(ina?.survivedPct >= 0 && ina?.survivedPct <= 100, 'replay: hider survival % in range', String(ina?.survivedPct))
assert(eva?.survivedPct === 0 && eva?.catchPctSum === 0, 'replay: hunter without catches has no catch %')
assert(ina?.fixCount === 1 && ina?.distanceM === 0, 'replay: fix count + distance from the GPS log')
assert(eva?.fixCount === 0 && eva?.distanceM === 0 && eva?.exposures === 0, 'replay: no fixes → no distance')

// Boot backfill: a match recorded before the stats table gets its stats.
const oldId = '00000000-0000-4000-8000-00000000aaaa'
mem.matches.set(oldId, {
  id: oldId,
  lobbyCode: 'OLD',
  startedAt: new Date(),
  endedAt: new Date(),
  winner: 'hiders',
  reason: 'r',
  eventCount: 2,
  settings: {},
  players: [],
})
mem.events.set(oldId, [
  { seq: 1, at: new Date(), event: 'room:state_changed', payload: { roomState: { status: 'active', players: { x1: { id: 'x1', name: 'Xenia', role: 'hider' } } } } },
  { seq: 2, at: new Date(), event: 'game:over', payload: { winner: 'hiders', reason: 'r' } },
])
await svc.backfillStats()
const oldStats = mem.statsByMatch.get(oldId) ?? []
assert(
  oldStats.length === 1 && oldStats[0].name === 'Xenia' && oldStats[0].won === true && oldStats[0].survived === true,
  'replay: boot backfill derives stats for pre-stats matches',
  JSON.stringify(oldStats),
)

// ------------------------------------------------------- replay REST (e2e)

// Full pipeline through a real server: sockets play a compact match, the
// recorder observes it, the REST API serves it back.
const replayStore = memoryStore()
const replayApp = createApp({ replayStore })
const REPLAY_PORT = 3998
await new Promise((resolve) => replayApp.httpServer.listen(REPLAY_PORT, resolve))
const REPLAY_URL = `http://localhost:${REPLAY_PORT}`

const hostR = await new Promise((resolve, reject) => {
  const s = io(`${REPLAY_URL}/`, { transports: ['websocket'] })
  s.on('connect', () => resolve(s))
  s.on('connect_error', reject)
  setTimeout(() => reject(new Error('replay host connect timeout')), 4000)
})
const createdR = await emitAck(hostR, 'room:create', {
  hostName: 'Eva',
  role: 'hunter',
  zoneCenter: ZONE,
  settings: {
    gameDurationSeconds: 180,
    hidePhaseSeconds: 0,
    initialZoneRadius: 100,
    zoneShrinkInterval: 600,
    zoneShrinkPercent: 10,
    zoneShiftEnabled: false,
    endgameEnabled: false,
    hiderRevealInterval: 60,
    proximityDistanceMeters: 5,
    proximityBeepInterval: 5,
  },
})
assert(createdR?.ok, 'replay e2e: room created')
const codeR = createdR.roomState.code
const hostRId = createdR.yourPlayerId
const hiderR = await new Promise((resolve, reject) => {
  const s = io(`${REPLAY_URL}/`, { transports: ['websocket'] })
  s.on('connect', () => resolve(s))
  s.on('connect_error', reject)
  setTimeout(() => reject(new Error('replay hider connect timeout')), 4000)
})
const joinedR = await emitAck(hiderR, 'room:join', { roomCode: codeR, playerName: 'Ina', role: 'hider' })
assert(joinedR?.ok, 'replay e2e: hider joined')
const hiderRId = joinedR.yourPlayerId

// A lobby fix — before the match, so it must NOT enter the log.
hiderR.emit('player:location', { lat: 52.0005, lng: 13.0, accuracy: 5 })
await sleep(150)
await emitAck(hostR, 'game:start', { roomCode: codeR })
await once(hiderR, 'game:tick') // main phase is running
hiderR.emit('player:location', { lat: 51.9995, lng: 13.0, accuracy: 5 }) // in-zone fix
hiderR.emit('player:location', { lat: 91, lng: 13.0, accuracy: 5 }) // junk — rejected
await sleep(150)
// The hider reports being caught by the host — terminal, hunters win.
// game:over is broadcast before the ack resolves — listen first.
const gameOverR = once(hiderR, 'game:over')
await emitAck(hiderR, 'hider:captured', { roomCode: codeR, hiderId: hiderRId, hunterId: hostRId })
await gameOverR
await sleep(300) // let the recorder flush + seal

const listRes = await fetch(`${REPLAY_URL}/api/matches`)
const listBody = await listRes.json()
assert(listRes.status === 200 && listBody.matches?.length === 1, 'replay e2e: exactly one match listed', JSON.stringify(listBody).slice(0, 200))
const listed = listBody.matches[0]
assert(listed.lobbyCode === codeR, 'replay e2e: listed under its lobby code')
assert(listed.winner === 'hunters' && listed.playerCount === 2, 'replay e2e: result + player count listed')

const matchRes = await fetch(`${REPLAY_URL}/api/matches/${listed.id}`)
const { match: fetchedMatch, events: logged } = await matchRes.json()
assert(matchRes.status === 200 && fetchedMatch?.id === listed.id, 'replay e2e: match fetched by id')
assert(fetchedMatch.settings?.gameDurationSeconds === 180, 'replay e2e: settings snapshot delivered')
const kinds = logged.map((e) => e.event)
assert(kinds[0] === 'room:state_changed' && kinds.at(-1) === 'game:over', 'replay e2e: log runs from the active state to game:over', JSON.stringify(kinds))
assert(logged.every((e, i) => i === 0 || e.seq > logged[i - 1].seq), 'replay e2e: seq strictly increasing')
const loggedFixes = logged.filter((e) => e.event === 'player:location')
assert(
  loggedFixes.length === 1 && loggedFixes[0].payload.playerId === hiderRId && loggedFixes[0].payload.lat === 51.9995,
  'replay e2e: exactly the one accepted in-match fix is logged',
  JSON.stringify(loggedFixes.map((f) => f.payload)),
)
const overEvent = logged.at(-1)
assert(overEvent.payload.winner === 'hunters', 'replay e2e: game:over result in the log')

assert((await fetch(`${REPLAY_URL}/api/matches/${listed.id.slice(0, 8)}`)).status === 404, 'replay e2e: malformed id → 404')
const randomUuid = '00000000-0000-4000-8000-000000000000'
assert((await fetch(`${REPLAY_URL}/api/matches/${randomUuid}`)).status === 404, 'replay e2e: unknown id → 404')

// Leaderboard + player stats over the played match (Eva caught Ina).
const lbRes = await fetch(`${REPLAY_URL}/api/leaderboard`)
const { leaderboard: lb } = await lbRes.json()
assert(lbRes.status === 200 && lb.length === 2, 'replay e2e: leaderboard lists both players', JSON.stringify(lb))
const evaLb = lb.find((p) => p.name === 'Eva')
const inaLb = lb.find((p) => p.name === 'Ina')
assert(
  evaLb?.wins === 1 && evaLb?.hunterMatches === 1 && evaLb?.captures === 1,
  'replay e2e: hunter credited with the reported capture',
  JSON.stringify(evaLb),
)
assert(
  inaLb?.timesCaught === 1 && inaLb?.hiderMatches === 1 && inaLb?.wins === 0,
  'replay e2e: caught hider stats',
  JSON.stringify(inaLb),
)
assert(
  inaLb?.avgSurvivedPct > 0 &&
    inaLb?.avgSurvivedPct <= 100 &&
    evaLb?.avgCatchPct > 0 &&
    evaLb?.avgCatchPct <= 100,
  'replay e2e: time-based percentages in range (caught at the end of a short match)',
  JSON.stringify({ ina: inaLb?.avgSurvivedPct, eva: evaLb?.avgCatchPct }),
)
const playerRes = await fetch(`${REPLAY_URL}/api/players/ina`) // case-insensitive lookup
const playerBody = await playerRes.json()
assert(
  playerRes.status === 200 && playerBody?.stats?.matches === 1 && playerBody?.matches?.length === 1 && playerBody.matches[0].captured === true,
  'replay e2e: player page aggregates by name, lists the match',
  JSON.stringify(playerBody),
)
assert((await fetch(`${REPLAY_URL}/api/players/${encodeURIComponent('Nobody')}`)).status === 404, 'replay e2e: unknown player → 404')

hostR.disconnect()
hiderR.disconnect()
replayApp.httpServer.close()

// ---------------------------------------------------------------- teardown

host.disconnect()
hunter.disconnect()
hider.disconnect()
httpServer.close()

console.log(`\n▶ ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
