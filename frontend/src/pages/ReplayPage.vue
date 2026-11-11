<template>
  <q-page class="replay-page">
    <div ref="mapEl" class="replay-map" />

    <!-- top overlay: navigation, match info, result -->
    <div class="replay-top absolute-top q-pa-sm row items-start justify-between">
      <q-btn dense round dark icon="arrow_back" @click="$router.push('/replays')" />
      <div class="column items-center text-center">
        <div class="text-subtitle1 text-weight-bold mm-mono">{{ match?.lobbyCode ?? '…' }}</div>
        <div class="text-caption text-grey-5">{{ formatMatchDate(match?.startedAt) }}</div>
      </div>
      <span class="spacer-40" />
    </div>

    <!-- phase / countdown chip -->
    <div
      class="absolute-top column items-center q-mt-xl q-pt-md full-width"
      style="pointer-events: none"
    >
      <div v-if="frame" class="replay-phase-chip">
        <template v-if="frame.status === 'ended'">
          <q-icon
            :name="frame.winner === 'hunters' ? 'radar' : 'visibility_off'"
            size="16px"
            :color="frame.winner === 'hunters' ? 'red' : 'green'"
          />
          {{ resultLabel }}
        </template>
        <template v-else-if="frame.phase === 'hiding'">
          <q-icon name="hourglass_top" size="16px" /> Verstecken
          {{ formatClock(frame.hideRemaining) }}
        </template>
        <template v-else-if="frame.phase === 'endgame'">
          <q-icon name="sports_score" size="16px" class="text-yellow" /> Endgame
          {{ formatClock(frame.endgameRemaining) }}
        </template>
        <template v-else>
          <q-icon name="timer" size="16px" /> {{ formatClock(frame.timeRemaining) }}
        </template>
      </div>
      <div
        v-if="frame?.status === 'ended' && frame.reason"
        class="text-caption text-grey-5 q-mt-xs replay-reason"
      >
        {{ frame.reason }}
      </div>
    </div>

    <!-- loading / error -->
    <div v-if="loading" class="absolute-center column items-center">
      <q-spinner-dots size="56px" color="primary" />
    </div>
    <div v-else-if="error" class="absolute-center column items-center text-negative">
      <q-icon name="cloud_off" size="40px" />
      <div class="q-mt-sm">{{ error }}</div>
    </div>

    <!-- bottom panel: players + playback controls -->
    <div class="replay-controls absolute-bottom q-pa-sm" v-if="!loading && !error">
      <div class="players-row q-mb-xs">
        <q-chip
          v-for="p in frame?.players ?? []"
          :key="p.id"
          clickable
          dark
          :style="{ '--chip-color': pinColor(p) }"
          class="player-chip"
          @click="flyToPlayer(p)"
        >
          <q-icon :name="p.role === 'hunter' ? 'radar' : 'visibility_off'" size="14px" />
          {{ p.name }}{{ p.captured ? ' ✕' : '' }}
        </q-chip>
      </div>
      <div class="row items-center no-wrap q-gutter-x-sm">
        <q-btn
          round
          dense
          dark
          color="primary"
          :icon="playing ? 'pause' : 'play_arrow'"
          @click="togglePlay"
        />
        <div class="col">
          <q-slider
            v-model="sec"
            dark
            :min="0"
            :max="Math.max(timeline.seconds, 1)"
            label
            :label-value="formatClock(sec)"
          />
        </div>
        <div class="text-caption text-grey-4 no-wrap mm-mono">
          {{ formatClock(sec) }} / {{ formatClock(timeline.seconds) }}
        </div>
      </div>
      <div class="row items-center justify-between q-mt-xs">
        <q-btn-toggle
          v-model="speed"
          dark
          dense
          no-caps
          unelevated
          toggle-color="primary"
          :options="[
            { label: '1×', value: 1 },
            { label: '2×', value: 2 },
            { label: '4×', value: 4 },
            { label: '8×', value: 8 },
            { label: '30×', value: 30 },
            { label: '60×', value: 60 },
          ]"
        />
        <q-toggle v-model="showTrails" dark dense label="Spuren" class="text-caption" />
      </div>
    </div>
  </q-page>
</template>

<script setup>
/**
 * Replay viewer — plays a recorded match back on the map: zone, endgame
 * preview, all players' true positions (with track lines) and the result.
 * Frames come pre-computed from services/replay.js; the slider seeks freely.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { api } from '@/services/api'
import { buildTimeline, formatClock, formatMatchDate } from '@/services/replay'

const route = useRoute()

const mapEl = ref(null)
const loading = ref(true)
const error = ref(null)
const match = ref(null)
const timeline = ref({ startAt: null, seconds: 0, frames: [], trails: new Map() })
const sec = ref(0)
const playing = ref(false)
const speed = ref(4)
const showTrails = ref(true)

// The frame for the current position. `sec` runs FRACTIONAL during playback
// (the interval advances it in sub-second steps) — the frames array is
// indexed by whole seconds, so floor it or the lookup returns undefined and
// the map silently freezes while playing.
const frame = computed(() => {
  const frames = timeline.value.frames
  return frames[Math.min(Math.floor(sec.value), frames.length - 1)] ?? null
})
const resultLabel = computed(() => {
  if (frame.value?.winner === 'hiders') return 'Verstecker gewinnen'
  if (frame.value?.winner === 'hunters') return 'Jäger gewinnen'
  return 'Spiel beendet'
})

// ------------------------------------------------------------- leaflet map

const COLORS = {
  hunter: '#ff5252',
  hider: '#00e676',
  exposed: '#ffab00',
  captured: '#9e9e9e',
  zone: '#00e676',
  endgame: '#ffea00',
}

/** How long an event pulse keeps running while PLAYING (real seconds). */
const PULSE_MS = 3000

let map = null
let zoneCircle = null
let endgameCircle = null
const trailLayer = L.layerGroup()
const markerLayer = L.layerGroup()
/** playerId → { marker, iconKey } — pins are reused across frames. */
const markers = new Map()
/** playerId → { polyline, lastPointCount } — trails redrawn per frame. */
const trails = new Map()
/** playerId → real timestamp until which the pin pulses (play mode). */
const pulseUntil = new Map()

function initial(name = '') {
  return String(name).trim().charAt(0).toUpperCase() || '?'
}

function pinColor(p) {
  if (p.captured) return COLORS.captured
  if (p.isExposedLive) return COLORS.exposed // hider outside the zone
  return p.role === 'hunter' ? COLORS.hunter : COLORS.hider
}

/**
 * Is this player's pin pulsing right now?
 * - Paused: infinitely while the annotated second/condition holds (a reveal
 *   second, the capture second, the exposure — for inspection).
 * - Playing: for PULSE_MS after the event second was crossed (registered in
 *   registerPulses), then the pulse ends — the pin color (orange while
 *   outside the zone, grey once captured) persists either way.
 */
function pulseActive(p) {
  const f = frame.value
  if (!f) return false
  if (!playing.value) {
    return (
      (f.reveal && p.role === 'hider' && !p.captured) ||
      f.sec === p.capturedSec ||
      !!p.isExposedLive
    )
  }
  return Date.now() < (pulseUntil.get(p.id) ?? 0)
}

/** Register a 3 s pulse for a player (play mode), re-rendering at expiry. */
function markPulse(id) {
  pulseUntil.set(id, Date.now() + PULSE_MS)
  setTimeout(() => render(), PULSE_MS + 50)
}

/**
 * While playing: walk every match-second crossed between two positions on
 * the timeline and start pulses for the events found there (reveals,
 * captures, hiders leaving the zone).
 */
function registerPulses(fromSec, toSec) {
  const frames = timeline.value.frames
  for (let s = Math.max(0, Math.floor(fromSec ?? 0)); s <= Math.floor(toSec ?? 0); s++) {
    const f = frames[Math.min(s, frames.length - 1)]
    if (!f) break
    for (const p of f.players) {
      const discovered = (f.reveal && p.role === 'hider' && !p.captured) || f.sec === p.capturedSec
      if (discovered || f.sec === p.exposedSec) markPulse(p.id)
    }
  }
}

/** Same teardrop pin as the live map (styles copied, see <style> below). */
function pinIcon(color, glyph, dead, pulse) {
  return L.divIcon({
    className: 'mm-marker-wrap',
    html: `<div class="mm-marker${pulse ? ' mm-marker--pulse' : ''}" style="--mm-color:${color}"><span>${glyph}</span>${
      dead ? '<span class="mm-x-badge">✕</span>' : ''
    }</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function ensureMap() {
  if (map || !mapEl.value) return
  map = L.map(mapEl.value, { zoomControl: true, attributionControl: true })
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_4ye0_1_21cbe6bec479d1b4517c2148',
    {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
  ).addTo(map)
  map.attributionControl.setPrefix('')
  trailLayer.addTo(map)
  markerLayer.addTo(map)
}

/** Frame everything that matters once, after the match is loaded. */
function fitAll() {
  const points = []
  for (const pts of timeline.value.trails.values()) {
    for (const t of pts) points.push([t.lat, t.lng])
  }
  if (timeline.value.frames[0]?.zone) {
    const z = timeline.value.frames[0].zone
    try {
      const bounds = L.latLngBounds([[z.lat, z.lng]]).pad(0) // expanded below by radius
      points.push(
        [z.lat - z.radius / 111000, z.lng - z.radius / 80000],
        [z.lat + z.radius / 111000, z.lng + z.radius / 80000],
      )
      bounds.extend(points)
      map.fitBounds(bounds, { padding: [28, 28] })
      return
    } catch {
      // fall through to setView
    }
  }
  if (points.length) {
    map.fitBounds(L.latLngBounds(points), { padding: [28, 28] })
  } else {
    map.setView([0, 0], 2)
  }
}

function setZone(zone) {
  if (!map) return
  if (!zone) {
    zoneCircle?.remove()
    zoneCircle = null
    return
  }
  if (!zoneCircle) {
    zoneCircle = L.circle([zone.lat, zone.lng], {
      radius: zone.radius,
      color: COLORS.zone,
      weight: 2,
      dashArray: '6 6',
      fillColor: COLORS.zone,
      fillOpacity: 0.07,
      interactive: false,
    }).addTo(map)
  } else {
    zoneCircle.setLatLng([zone.lat, zone.lng])
    zoneCircle.setRadius(zone.radius)
  }
}

function setEndgameZone(z) {
  if (!map || !z) {
    endgameCircle?.remove()
    endgameCircle = null
    return
  }
  if (!endgameCircle) {
    endgameCircle = L.circle([z.lat, z.lng], {
      radius: z.radius,
      color: COLORS.endgame,
      weight: 3,
      dashArray: '8 8',
      fillColor: COLORS.endgame,
      fillOpacity: 0.08,
      interactive: false,
      className: 'mm-endgame-circle',
    }).addTo(map)
  } else {
    endgameCircle.setLatLng([z.lat, z.lng])
    endgameCircle.setRadius(z.radius)
  }
}

/** Draw every player's track up to the current second. */
function redrawTrails(upToSec) {
  if (!map) return
  for (const [id, trail] of timeline.value.trails) {
    const pts = trail.filter((t) => t.sec <= upToSec)
    if (!pts.length) continue
    const recent = pts.slice(-400) // keep the SVG cheap on long matches
    let entry = trails.get(id)
    if (!entry) {
      entry = {
        polyline: L.polyline([], {
          color: '#ffffff',
          weight: 1.5,
          opacity: 0.3,
          interactive: false,
        }),
      }
      trails.set(id, entry)
    }
    if (entry.lastPointCount !== recent.length) {
      entry.lastPointCount = recent.length
      entry.polyline.setLatLngs(recent.map((t) => [t.lat, t.lng]))
    }
    entry.polyline.setStyle({ opacity: showTrails.value ? 0.3 : 0 })
    if (!entry.polyline.map) entry.polyline.addTo(trailLayer)
  }
}

// ------------------------------------------------------------ smooth moves

const SMOOTH_MOVE_MS = 700
/** Beyond this distance the pin jumps — a tween across the map looks wrong. */
const SMOOTH_MOVE_MAX_METERS = 200

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

/**
 * GLIDE (same as the live map): tween a pin to `to` with an ease-out curve
 * via rAF — replay fixes arrive once per second, the tween keeps the motion
 * continuous. Jump instantly for teleports (> 200 m) and while SEEKING
 * (`jump` — scrubbing must not animate across the whole match).
 */
function smoothMove(marker, to, { duration = SMOOTH_MOVE_MS, jump = false } = {}) {
  cancelTween(marker)
  const from = marker.getLatLng()
  if (from.lat === to.lat && from.lng === to.lng) return
  if (jump || !Number.isFinite(from.lat) || haversineMeters(from, to) > SMOOTH_MOVE_MAX_METERS) {
    marker.setLatLng([to.lat, to.lng])
    return
  }
  const start = performance.now()
  const frame = (now) => {
    const t = Math.min(1, (now - start) / duration)
    const e = 1 - (1 - t) ** 3 // easeOutCubic
    marker.setLatLng([from.lat + (to.lat - from.lat) * e, from.lng + (to.lng - from.lng) * e])
    marker._mmTween = t < 1 ? requestAnimationFrame(frame) : null
  }
  marker._mmTween = requestAnimationFrame(frame)
}

function cancelTween(marker) {
  if (marker._mmTween) {
    cancelAnimationFrame(marker._mmTween)
    marker._mmTween = null
  }
}

function redrawMarkers(f) {
  if (!map || !f) return
  const seen = new Set()
  for (const p of f.players) {
    if (!p.pos) continue
    seen.add(p.id)
    const icon = pinIcon(pinColor(p), initial(p.name), p.captured, pulseActive(p))
    const key = icon.options.html
    let entry = markers.get(p.id)
    if (!entry) {
      entry = {
        marker: L.marker([p.pos.lat, p.pos.lng], { icon, interactive: false }).addTo(markerLayer),
        iconKey: key,
      }
      markers.set(p.id, entry)
      continue
    }
    if (entry.iconKey !== key) {
      entry.iconKey = key
      entry.marker.setIcon(icon)
    }
    // Glide between fixes while playing; snap while scrubbing the timeline.
    smoothMove(entry.marker, p.pos, { jump: !playing.value })
  }
  for (const [id, entry] of markers) {
    if (!seen.has(id)) {
      cancelTween(entry.marker)
      entry.marker.remove()
      markers.delete(id)
    }
  }
}

function render() {
  const f = frame.value
  if (!map || !f) return
  setZone(f.zone)
  setEndgameZone(f.endgameZone)
  redrawMarkers(f)
  redrawTrails(f.sec)
}

// --------------------------------------------------------------- playback

let timer = null

function togglePlay() {
  playing.value = !playing.value
  if (playing.value && sec.value >= timeline.value.seconds) sec.value = 0 // replay from the top
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(sec, (s, prev) => {
  // While playing, every crossed match-second starts 3 s pulses for the
  // events it holds (reveals, captures, hiders leaving the zone).
  if (playing.value) registerPulses(prev, s)
  render()
})
watch(showTrails, () => redrawTrails(sec.value))

watch(playing, (on) => {
  stopTimer()
  if (on) {
    // Resuming on an event second: pulse it too (e.g. paused on a reveal).
    registerPulses(sec.value - 1, sec.value)
    timer = setInterval(() => {
      if (sec.value >= timeline.value.seconds) {
        playing.value = false
        return
      }
      sec.value = Math.min(timeline.value.seconds, sec.value + speed.value / 5) // 5 ticks/s
    }, 200)
  }
})

function flyToPlayer(p) {
  if (p.pos) map?.flyTo([p.pos.lat, p.pos.lng], 16)
}

// --------------------------------------------------------------- lifecycle

onMounted(async () => {
  ensureMap()
  try {
    const { match: m, events } = await api.match(route.params.id)
    match.value = m
    timeline.value = buildTimeline(events)
    fitAll()
    render()
  } catch (err) {
    error.value = err.message || 'Replay konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  stopTimer()
  for (const entry of markers.values()) cancelTween(entry.marker)
  map?.remove()
  map = null
  zoneCircle = null
  endgameCircle = null
  markers.clear()
  trails.clear()
})
</script>

<style scoped>
.replay-page {
  overflow: hidden;
}

.replay-map {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.replay-top {
  z-index: 1100;
  pointer-events: none;
}

.replay-top :deep(.q-btn) {
  pointer-events: auto;
}

.spacer-40 {
  width: 40px;
}

.replay-phase-chip {
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(16, 20, 19, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 14px;
  font-weight: 600;
}

.replay-reason {
  max-width: 90vw;
  text-align: center;
}

.replay-controls {
  z-index: 1100;
  left: 0;
  right: 0;
  background: rgba(16, 20, 19, 0.88);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(6px);
}

.players-row {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.player-chip {
  border: 1px solid color-mix(in srgb, var(--chip-color, #40c4ff) 55%, transparent);
  color: var(--chip-color, #40c4ff);
  flex-shrink: 0;
}

.mm-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>

<style>
/* Pin styles for the replay viewer (Leaflet injects plain DOM — global CSS).
   Same visual language as the live map's markers (components/GameMap.vue). */
.replay-page .mm-marker-wrap {
  background: transparent;
  border: none;
}

.replay-page .mm-marker {
  width: 24px;
  height: 24px;
  border-radius: 50% 50% 50% 4px;
  transform: rotate(-45deg);
  background: var(--mm-color, #40c4ff);
  border: 2px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
}

.replay-page .mm-marker > span {
  transform: rotate(45deg);
  font-size: 11px;
  font-weight: 700;
  color: #101010;
  line-height: 1;
}

.replay-page .mm-x-badge {
  position: absolute;
  top: -7px;
  right: -7px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #174d2e;
  border: 1px solid #ffffff;
  color: #ffffff;
  font-size: 9px;
  font-weight: 700;
  line-height: 11px;
  text-align: center;
  transform: rotate(45deg);
}

.replay-page .mm-endgame-circle {
  animation: mm-endgame-pulse 1.2s ease-in-out infinite;
}

/* Event pulse (discovered / outside the zone / captured): an expanding ring
   tinted with the pin's own color. While PAUSED the animation runs infinitely
   (the class stays as long as the condition holds); while PLAYING the pin
   keeps the class only for the 3 s after the event second (see pulseActive). */
.replay-page .mm-marker--pulse {
  animation: mm-replay-pulse 1s ease-out infinite;
}

@keyframes mm-replay-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--mm-color, #ffab00) 70%, transparent);
  }
  70% {
    box-shadow: 0 0 0 14px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

@keyframes mm-endgame-pulse {
  0%,
  100% {
    stroke-opacity: 1;
    stroke-width: 3px;
  }
  50% {
    stroke-opacity: 0.3;
    stroke-width: 1.5px;
  }
}
</style>
