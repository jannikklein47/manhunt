/**
 * Central game store: owns the Socket.io wiring, the proximity beep loop
 * (Web Audio API), GPS tracking (Geolocation API) and the screen wake lock.
 */
import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { playBeep } from '@/services/audio'
import { GPS_QUALITY_MAX, GPS_REPORT_MAX, watchPosition } from '@/services/geo'
import { socket } from '@/services/socket'
import { releaseWakeLock, requestWakeLock } from '@/services/wakeLock'

/** Minimum delay between two location emits (server only needs ~1 Hz). */
const LOCATION_EMIT_THROTTLE_MS = 1000

/** Socket listeners must only ever be bound once per connection. */
let listenersBound = false

export const useGameStore = defineStore('game', () => {
  // ------------------------------------------------------------ state

  const connected = ref(socket.connected)
  const roomState = ref(null)
  const myPlayerId = ref(null)
  const tick = ref(null) // { timeRemaining, currentZoneRadius, nextShrinkIn }
  const hunterPositions = ref([])
  const hiderPositions = ref([])
  const proximity = ref({ inRange: false, interval: null })
  const gameOver = ref(null)
  const lastError = ref(null)

  const myPosition = ref(null) // own GPS fix { lat, lng, accuracy, timestamp, manual? }
  const gpsWeak = ref(false) // last fixes were too inaccurate
  const gpsError = ref(null)

  /**
   * Manual location (testing tool). `manualEnabled` controls whether the
   * feature is available at all — OFF by default, persisted, and meant to
   * be flipped off before a real game. `manualMode` is the live switch:
   * GPS tracking vs. tap-the-map-to-place-yourself.
   */
  const manualEnabled = ref(localStorage.getItem('manhunt:manualLocation') === '1')
  const manualMode = ref(false)

  const revealSeq = ref(0) // bumps on every server-side hider reveal (drives the wave animation)

  /**
   * Captured hider's "found here" spot — pins a dead marker on their own map
   * where they were caught, while their live position keeps tracking (grey).
   */
  const deadPin = ref(null)

  // ------------------------------------------------------------ getters

  const me = computed(() => roomState.value?.players?.[myPlayerId.value] || null)
  const isHost = computed(() => !!roomState.value && roomState.value.hostId === myPlayerId.value)
  const amHunter = computed(() => me.value?.role === 'hunter')
  const amHider = computed(() => me.value?.role === 'hider')
  const players = computed(() => Object.values(roomState.value?.players || {}))
  const hunters = computed(() => players.value.filter((p) => p.role === 'hunter'))
  const hiders = computed(() => players.value.filter((p) => p.role === 'hider'))
  const uncaughtHiders = computed(() => hiders.value.filter((p) => !p.captured))
  const roomCode = computed(() => roomState.value?.code || null)
  const status = computed(() => roomState.value?.status || 'idle')
  const zoneRadius = computed(
    () => tick.value?.currentZoneRadius ?? roomState.value?.currentZoneRadius ?? 0,
  )
  const settings = computed(() => roomState.value?.settings || null)

  // ----------------------------------------------------- proximity beeps

  let beepTimer = null

  function stopBeepLoop() {
    if (beepTimer) {
      clearInterval(beepTimer)
      beepTimer = null
    }
  }

  /**
   * Beep immediately on `inRange: true`, then repeat on the host-configured
   * `proximityBeepInterval` until the server flips `inRange` back to false.
   */
  function startBeepLoop(intervalSeconds) {
    stopBeepLoop()
    playBeep()
    const ms = Math.max(5, Number(intervalSeconds) || 30) * 1000
    beepTimer = setInterval(() => playBeep(), ms)
  }

  // ------------------------------------------------------ socket wiring

  if (!listenersBound) {
    listenersBound = true

    socket.on('connect', () => {
      connected.value = true
    })
    socket.on('disconnect', () => {
      connected.value = false
    })

    socket.on('room:error', (payload) => {
      lastError.value = payload?.message || 'Unknown error'
    })

    socket.on('room:state_changed', ({ roomState: rs } = {}) => {
      if (!rs) return
      const prevStatus = roomState.value?.status
      roomState.value = rs

      if (rs.status !== 'active') {
        stopBeepLoop()
        proximity.value = { inRange: false, interval: proximity.value.interval }
      }
      if (rs.status === 'lobby') {
        // Only on ENTERING the lobby (first join / rematch reset) — NOT on
        // every lobby broadcast (settings updates would wipe the pins).
        if (prevStatus !== 'lobby') {
          tick.value = null
          gameOver.value = null
          hunterPositions.value = []
          hiderPositions.value = []
          // Report the current position right away: GPS fixes only re-emit
          // on movement, so a stationary player would otherwise be invisible
          // until their first move.
          if (myPosition.value) sendLocation(myPosition.value, true)
        }
      }
      if (rs.status === 'ended') {
        // Game over: wipe all position pins — the map shows only the zone.
        hunterPositions.value = []
        hiderPositions.value = []
      }
      if (rs.status === 'active' && prevStatus !== 'active' && rs.phase === 'hiding') {
        // The hunt just began with a head start: hiders are hidden again —
        // drop the pins seen in the lobby so hunters start with a clean map.
        hiderPositions.value = []
      }
    })

    socket.on('game:tick', (payload = {}) => {
      tick.value = payload
    })

    socket.on('map:hunter_positions', (list = []) => {
      hunterPositions.value = list
    })

    socket.on('map:hider_positions', (list = []) => {
      hiderPositions.value = list
    })

    // Server-side reveal pulse: fires on every scheduled hider reveal —
    // hunters wave the snapshot pins, hiders wave their own pin.
    socket.on('hiders:revealed', () => {
      revealSeq.value++
    })

    socket.on('player:proximity_alert', ({ inRange, interval } = {}) => {
      proximity.value = { inRange, interval }
      if (inRange) startBeepLoop(interval)
      else stopBeepLoop()
    })

    socket.on('game:over', ({ winner, reason } = {}) => {
      gameOver.value = { winner, reason }
      stopBeepLoop()
      releaseWakeLock()
    })
  }

  // ------------------------------------------------------ wake lock

  // Hold a screen wake lock for the whole room lifetime (lobby → end):
  // re-acquired automatically on visibilitychange by the service.
  watch(status, (next) => {
    if (next === 'active') requestWakeLock()
    else if (next === 'ended' || next === 'idle') releaseWakeLock()
  })

  // DEAD PIN: the moment this player is captured, freeze their current
  // position as the "found here" spot. Cleared on reset/reconnect.
  watch(
    () => me.value?.captured,
    (captured, was) => {
      if (captured && !was) {
        deadPin.value = myPosition.value
          ? { lat: myPosition.value.lat, lng: myPosition.value.lng }
          : null
      } else if (!captured) {
        deadPin.value = null
      }
    },
  )

  // ------------------------------------------------------ GPS tracking

  let stopWatch = null
  let lastEmitAt = 0

  function startTracking() {
    if (stopWatch || manualMode.value) return // manual mode owns the position
    gpsError.value = null
    gpsWeak.value = false
    stopWatch = watchPosition({
      onFix: (fix) => {
        gpsError.value = null
        // Own position is ALWAYS shown — even a low-accuracy fix is better
        // than a blank map. The accuracy circle conveys the uncertainty.
        myPosition.value = fix
        const quality = fix.accuracy <= GPS_QUALITY_MAX
        gpsWeak.value = !quality
        // Report degraded fixes too (up to GPS_REPORT_MAX) so the game keeps
        // working with weak GPS — the server only trusts quality fixes for
        // proximity alerts and exposure decisions.
        if (fix.accuracy <= GPS_REPORT_MAX) sendLocation(fix)
      },
      onError: (err) => {
        gpsError.value = err.message || 'GPS unavailable'
      },
    })
  }

  function stopGpsWatch() {
    stopWatch?.()
    stopWatch = null
  }

  function stopTracking() {
    stopGpsWatch()
    myPosition.value = null
    gpsWeak.value = false
  }

  function sendLocation(fix, force = false) {
    const status = roomState.value?.status
    // Fixes count in the lobby too (everyone sees everyone there).
    if (status !== 'lobby' && status !== 'active') return
    // Captured players' fixes are dropped server-side — their dead pin must
    // stay frozen at the found spot — so don't bother sending.
    if (me.value?.captured) return
    const now = Date.now()
    if (!force && now - lastEmitAt < LOCATION_EMIT_THROTTLE_MS) return
    lastEmitAt = now
    socket.emit('player:location', { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy })
  }

  // --------------------------------------------- manual location (testing)

  /** Feature availability — off by default, persisted, easy to flip off. */
  function setManualEnabled(on) {
    manualEnabled.value = on
    localStorage.setItem('manhunt:manualLocation', on ? '1' : '0')
    if (on) {
      // Enabling IS the "deactivate GPS, use manual location" action — start
      // in manual mode right away so a map tap just works.
      setManualMode(true)
    } else if (manualMode.value) {
      setManualMode(false)
    }
  }

  /** Switch between live GPS and tap-the-map positioning. */
  function setManualMode(on) {
    if (!manualEnabled.value) on = false
    if (manualMode.value === on) return
    manualMode.value = on
    if (on) {
      // Deactivate GPS; keep the last known fix on the map as a starting point.
      stopGpsWatch()
      gpsError.value = null
      gpsWeak.value = false
    } else if (roomState.value) {
      startTracking()
    }
  }

  /** Map tap in manual mode: place yourself there and report like a GPS fix. */
  function setManualLocation({ lat, lng } = {}) {
    if (!manualEnabled.value || !manualMode.value) return
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    gpsError.value = null
    const fix = { lat, lng, accuracy: 0, timestamp: Date.now(), manual: true }
    myPosition.value = fix
    sendLocation(fix, true)
  }

  // ----------------------------------------------------------- actions

  function createRoom({ hostName, role, zoneCenter, settings: patch }) {
    return new Promise((resolve, reject) => {
      socket.emit('room:create', { hostName, role, zoneCenter, settings: patch }, (res) => {
        if (res?.ok) {
          roomState.value = res.roomState
          myPlayerId.value = res.yourPlayerId
          resolve(res)
        } else {
          reject(new Error(res?.error || 'Could not create the room'))
        }
      })
    })
  }

  function joinRoom({ roomCode, playerName, role }) {
    return new Promise((resolve, reject) => {
      socket.emit('room:join', { roomCode, playerName, role }, (res) => {
        if (res?.ok) {
          roomState.value = res.roomState
          myPlayerId.value = res.yourPlayerId
          resolve(res)
        } else {
          reject(new Error(res?.error || 'Could not join the room'))
        }
      })
    })
  }

  function updateSettings(patch) {
    if (!roomCode.value) return Promise.reject(new Error('Not in a room'))
    return new Promise((resolve, reject) => {
      socket.emit('room:update_settings', { roomCode: roomCode.value, settings: patch }, (res) => {
        if (res?.ok) resolve(res.settings)
        else reject(new Error(res?.error || 'Could not update settings'))
      })
    })
  }

  function setRole(role) {
    if (!roomCode.value) return
    socket.emit('player:set_role', { roomCode: roomCode.value, role })
  }

  function startGame() {
    if (!roomCode.value) return Promise.reject(new Error('Not in a room'))
    return new Promise((resolve, reject) => {
      socket.emit('game:start', { roomCode: roomCode.value }, (res) => {
        if (res?.ok) resolve()
        else reject(new Error(res?.error || 'Could not start the game'))
      })
    })
  }

  function resetGame() {
    if (!roomCode.value) return Promise.reject(new Error('Not in a room'))
    return new Promise((resolve, reject) => {
      socket.emit('game:reset', { roomCode: roomCode.value }, (res) => {
        if (res?.ok) resolve()
        else reject(new Error(res?.error || 'Could not reset the game'))
      })
    })
  }

  /** Hiders tap "Found by [Hunter]" — only the hider themselves may report. */
  function captureMe(hunterId) {
    if (!roomCode.value || !me.value) return Promise.reject(new Error('Not in a room'))
    return new Promise((resolve, reject) => {
      socket.emit(
        'hider:captured',
        { roomCode: roomCode.value, hiderId: myPlayerId.value, hunterId },
        (res) => {
          if (res?.ok) resolve()
          else reject(new Error(res?.error || 'Could not report the capture'))
        },
      )
    })
  }

  function leaveRoom() {
    if (!roomCode.value) return
    socket.emit('room:leave', { roomCode: roomCode.value })
    resetLocal()
  }

  function resetLocal() {
    stopBeepLoop()
    stopTracking()
    releaseWakeLock()
    manualMode.value = false
    deadPin.value = null
    roomState.value = null
    myPlayerId.value = null
    tick.value = null
    hunterPositions.value = []
    hiderPositions.value = []
    proximity.value = { inRange: false, interval: null }
    gameOver.value = null
  }

  function clearError() {
    lastError.value = null
  }

  return {
    // state
    connected,
    roomState,
    myPlayerId,
    tick,
    hunterPositions,
    hiderPositions,
    proximity,
    gameOver,
    lastError,
    myPosition,
    gpsWeak,
    gpsError,
    revealSeq,
    deadPin,
    manualEnabled,
    manualMode,
    // getters
    me,
    isHost,
    amHunter,
    amHider,
    players,
    hunters,
    hiders,
    uncaughtHiders,
    roomCode,
    status,
    zoneRadius,
    settings,
    // actions
    startTracking,
    stopTracking,
    sendLocation,
    setManualEnabled,
    setManualMode,
    setManualLocation,
    createRoom,
    joinRoom,
    updateSettings,
    setRole,
    startGame,
    resetGame,
    captureMe,
    leaveRoom,
    resetLocal,
    clearError,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGameStore, import.meta.hot))
}
