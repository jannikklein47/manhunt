<template>
  <div
    ref="mapEl"
    class="game-map"
    :class="{ 'game-map--pick': mode === 'picker', 'game-map--locate': tapToLocate }"
  />
</template>

<script setup>
/**
 * Leaflet map with dark tiles (CARTO Dark Matter).
 *
 * Renders:
 * - the shrinking safe zone (circle)
 * - live hunter markers (public to everyone)
 * - hider markers for hunters: snapshot positions + live markers while a
 *   hider is exposed outside the zone (pulsing)
 * - the own GPS position + accuracy circle
 *
 * In `picker` mode it emits `update:picked` when the host taps the map or
 * drags the center pin.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const props = defineProps({
  mode: { type: String, default: 'view' }, // 'view' | 'picker'
  zoneCenter: { type: Object, default: null }, // { lat, lng }
  zoneRadius: { type: Number, default: 0 },
  hunters: { type: Array, default: () => [] },
  hiders: { type: Array, default: () => [] },
  capturedIds: { type: Array, default: () => [] },
  myPosition: { type: Object, default: null },
  picked: { type: Object, default: null },
  /** Bump to make the map fit the zone bounds. */
  fitKey: { type: Number, default: 0 },
  /** Keep the own marker centered while moving. */
  follow: { type: Boolean, default: false },
  /** Bumps on every scheduled hider reveal → wave animation on hider pins. */
  revealSeq: { type: Number, default: 0 },
  /** Also wave the viewer's own pin (used by hiders on reveal). */
  waveOwnPin: { type: Boolean, default: false },
  /** Initial shown inside the own position dot. */
  ownInitial: { type: String, default: '' },
  /** This player is captured: own dot turns grey, no own reveal wave. */
  ownDead: { type: Boolean, default: false },
  /** Where this (captured) player was found — a dead pin on their own map. */
  ownDeadPin: { type: Object, default: null },
  /**
   * Manual-location testing mode: map taps emit `locate` so the player can
   * place themselves anywhere on the map.
   */
  tapToLocate: { type: Boolean, default: false },
})

const emit = defineEmits(['update:picked', 'locate'])

const mapEl = ref(null)

let map = null
let zoneCircle = null
let pickedMarker = null
let ownMarker = null
let ownAccuracy = null
let ownDeadMarker = null
const markerLayer = L.layerGroup()
/** Pins by player id — reused across redraws so moves can be animated. */
let hunterMarkers = new Map()
/** Hider pins by player id — the reveal wave targets these. */
let hiderMarkers = new Map()
let waveTimer = null
let wavedEls = []

const COLORS = {
  hunter: '#ff5252',
  hider: '#00e676',
  exposed: '#ffab00',
  captured: '#9e9e9e',
  own: '#40c4ff',
  zone: '#00e676',
}

/** First letter of a player name, for the pin glyph. */
function initial(name = '') {
  return String(name).trim().charAt(0).toUpperCase() || '?'
}

/**
 * A role pin: colored teardrop with the player's initial. Optional:
 * - `pulse` — box-shadow pulse while the position is streaming live
 * - `waveLive` — endless wave rings while the pin is exposed out of zone
 * - `dead` — grey pin with a ✕ badge (captured; never waves)
 */
function roleIcon(color, { pulse = false, waveLive = false, dead = false, glyph = '' } = {}) {
  const classes = [
    'mm-marker',
    pulse ? 'mm-marker--pulse' : '',
    waveLive ? 'mm-marker--wave-live' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return L.divIcon({
    className: 'mm-marker-wrap',
    html: `<div class="${classes}" style="--mm-color:${color}">${glyph ? `<span>${glyph}</span>` : ''}${
      dead ? '<span class="mm-x-badge">✕</span>' : ''
    }</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function ensureMap() {
  if (map || !mapEl.value) return
  map = L.map(mapEl.value, { zoomControl: true, attributionControl: true, worldCopyJump: true })

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

  // Leaflet requires an initial view before anything that projects lat/lng
  // (fitBounds, getBounds, panTo, …) can be called. If we already know where
  // to look, start there — otherwise show the world until a zone/GPS fix
  // arrives and fitZone() takes over.
  const initial = props.zoneCenter || props.picked || props.myPosition
  if (initial && Number.isFinite(initial.lat) && Number.isFinite(initial.lng)) {
    map.setView([initial.lat, initial.lng], 15)
  } else {
    map.setView([0, 0], 2)
  }

  markerLayer.addTo(map)

  // Picker mode places the zone center; tapToLocate fakes the own GPS fix.
  map.on('click', (e) => {
    if (props.mode === 'picker') {
      emit('update:picked', { lat: e.latlng.lat, lng: e.latlng.lng })
    } else if (props.tapToLocate) {
      emit('locate', { lat: e.latlng.lat, lng: e.latlng.lng })
    }
  })
  if (props.mode === 'picker') setPickedMarker(props.picked)

  if (props.zoneCenter) setZone(props.zoneCenter, props.zoneRadius)
  if (props.myPosition) setOwn(props.myPosition)
}

function setZone(center, radius) {
  if (!map || !center) return
  if (!zoneCircle) {
    zoneCircle = L.circle([center.lat, center.lng], {
      radius,
      color: COLORS.zone,
      weight: 2,
      dashArray: '6 6',
      fillColor: COLORS.zone,
      fillOpacity: 0.07,
      interactive: false, // the zone must not swallow map taps inside it
    }).addTo(map)
    // First render: frame the zone so the player sees the play area at once.
    fitZone()
  } else {
    zoneCircle.setLatLng([center.lat, center.lng])
    zoneCircle.setRadius(radius)
  }
}

function fitZone() {
  if (!map || !zoneCircle) return
  try {
    map.fitBounds(zoneCircle.getBounds(), { padding: [28, 28] })
  } catch {
    // Map not fully initialized yet (no view/size) — the initial setView or
    // the next fitKey bump will frame it.
  }
}

function setPickedMarker(picked) {
  if (!map) return
  if (!picked) {
    pickedMarker?.remove()
    pickedMarker = null
    return
  }
  if (!pickedMarker) {
    pickedMarker = L.marker([picked.lat, picked.lng], {
      draggable: true,
      icon: roleIcon(COLORS.own, { glyph: '◎' }),
    })
      .addTo(map)
      .on('dragend', (e) => {
        const { lat, lng } = e.target.getLatLng()
        emit('update:picked', { lat, lng })
      })
  } else {
    pickedMarker.setLatLng([picked.lat, picked.lng])
  }
}

function ownIcon(letter = '', dead = false) {
  return L.divIcon({
    className: 'mm-marker-wrap',
    html: `<div class="mm-own-dot${dead ? ' mm-own-dot--dead' : ''}" style="--mm-color:${
      dead ? COLORS.captured : COLORS.own
    }">${letter ? `<span>${letter}</span>` : ''}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  })
}

function setOwn(pos) {
  if (!map || !pos) return
  if (!ownMarker) {
    // High zIndexOffset keeps the own dot above hunter/hider markers.
    ownMarker = L.marker([pos.lat, pos.lng], {
      icon: ownIcon(props.ownInitial, props.ownDead),
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(map)
    ownAccuracy = L.circle([pos.lat, pos.lng], {
      radius: pos.accuracy || 0,
      color: props.ownDead ? COLORS.captured : COLORS.own,
      weight: 1,
      fillColor: props.ownDead ? COLORS.captured : COLORS.own,
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(map)
  } else {
    // Glide to the new fix; the accuracy circle rides along in lockstep and
    // its radius eases to the new value. On a jump (> 200 m, e.g. a manual
    // location tap) nothing tweens — snap the circle straight to the fix.
    const radiusFrom = ownAccuracy.getRadius()
    const radiusTo = pos.accuracy || 0
    const tweened = smoothMove(
      ownMarker,
      { lat: pos.lat, lng: pos.lng },
      {
        onFrame: (lat, lng, e) => {
          ownAccuracy.setLatLng([lat, lng])
          ownAccuracy.setRadius(radiusFrom + (radiusTo - radiusFrom) * e)
        },
      },
    )
    if (!tweened) {
      ownAccuracy.setLatLng([pos.lat, pos.lng])
      ownAccuracy.setRadius(radiusTo)
    }
  }
  if (props.follow && !pos.manual) map.panTo([pos.lat, pos.lng], { animate: true, duration: 0.4 })
}

/**
 * The captured player's own map: a static dead pin where they were found,
 * next to their still-tracking (grey) live position.
 */
function setOwnDeadPin(pos) {
  if (!map) return
  if (!pos || !props.ownDead) {
    ownDeadMarker?.remove()
    ownDeadMarker = null
    return
  }
  const icon = roleIcon(COLORS.captured, { dead: true, glyph: props.ownInitial })
  if (!ownDeadMarker) {
    ownDeadMarker = L.marker([pos.lat, pos.lng], {
      icon,
      zIndexOffset: 900,
      interactive: false,
    }).addTo(map)
  } else {
    ownDeadMarker.setLatLng([pos.lat, pos.lng])
    ownDeadMarker.setIcon(icon)
  }
}

function redrawMarkers() {
  if (!map) return
  const captured = new Set(props.capturedIds)
  const seenHunters = new Set()
  const seenHiders = new Set()

  for (const h of props.hunters) {
    if (h.lat == null || h.lng == null) continue
    seenHunters.add(h.id)
    upsertMarker(hunterMarkers, h, roleIcon(COLORS.hunter, { glyph: initial(h.name) }))
  }

  for (const h of props.hiders) {
    if (h.lat == null || h.lng == null) continue
    seenHiders.add(h.id)
    const isDead = captured.has(h.id)
    const color = isDead ? COLORS.captured : h.isExposedLive ? COLORS.exposed : COLORS.hider
    upsertMarker(
      hiderMarkers,
      h,
      roleIcon(color, {
        pulse: h.isExposedLive && !isDead,
        // Exposed pins wave continuously instead of only on reveals.
        waveLive: h.isExposedLive && !isDead,
        dead: isDead,
        glyph: initial(h.name),
      }),
    )
  }

  // Drop pins whose player vanished (left the room, game ended, …).
  dropStale(hunterMarkers, seenHunters)
  dropStale(hiderMarkers, seenHiders)
}

/** Update-or-create a pin; existing pins glide to their new position. */
function upsertMarker(store, data, icon) {
  let marker = store.get(data.id)
  if (!marker) {
    marker = L.marker([data.lat, data.lng], { icon, interactive: false }).addTo(markerLayer)
    store.set(data.id, marker)
    return
  }
  marker.setIcon(icon)
  smoothMove(marker, data)
}

/** Remove pins that are no longer in the payload. */
function dropStale(store, seen) {
  for (const [id, marker] of store) {
    if (seen.has(id)) continue
    cancelTween(marker)
    marker.remove()
    store.delete(id)
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
 * GLIDE: tween a marker to `to` with an ease-out curve via rAF — Leaflet
 * positions markers with a transform, so a CSS transition would also lag the
 * pins behind every pan/zoom. Jump instantly for teleports (manual location
 * taps, fresh reveal snapshots far away) and when there is nothing to animate.
 * `onFrame(lat, lng, eased)` lets callers move companion shapes (accuracy
 * circle) in lockstep.
 */
function smoothMove(
  marker,
  to,
  { duration = SMOOTH_MOVE_MS, maxMeters = SMOOTH_MOVE_MAX_METERS, onFrame } = {},
) {
  cancelTween(marker)
  const from = marker.getLatLng()
  if (from.lat === to.lat && from.lng === to.lng) return false
  if (!Number.isFinite(from.lat) || haversineMeters(from, to) > maxMeters) {
    marker.setLatLng([to.lat, to.lng])
    return false
  }
  const start = performance.now()
  const frame = (now) => {
    const t = Math.min(1, (now - start) / duration)
    const e = 1 - (1 - t) ** 3 // easeOutCubic
    const lat = from.lat + (to.lat - from.lat) * e
    const lng = from.lng + (to.lng - from.lng) * e
    marker.setLatLng([lat, lng])
    onFrame?.(lat, lng, e)
    marker._mmTween = t < 1 ? requestAnimationFrame(frame) : null
  }
  marker._mmTween = requestAnimationFrame(frame)
  return true
}

function cancelTween(marker) {
  if (marker._mmTween) {
    cancelAnimationFrame(marker._mmTween)
    marker._mmTween = null
  }
}

/**
 * REVEAL WAVE: expanding rings on every visible hider pin — for hunters on
 * the snapshot markers, for hiders on their own pin (via `waveOwnPin`).
 * Rings are tinted with each marker's own color via the `--mm-color` var.
 *
 * Skipped: captured pins (never wave) and exposed pins (they already wave
 * continuously via `mm-marker--wave-live`).
 */
function playRevealWave() {
  if (!map) return
  clearTimeout(waveTimer)
  for (const el of wavedEls) el.classList.remove('mm-wave')
  wavedEls = []

  const captured = new Set(props.capturedIds)
  for (const [id, marker] of hiderMarkers) {
    if (captured.has(id)) continue
    const el = marker.getElement()?.querySelector('.mm-marker')
    if (el && !el.classList.contains('mm-marker--wave-live')) wavedEls.push(el)
  }
  if (props.waveOwnPin && !props.ownDead && ownMarker) {
    const el = ownMarker.getElement()?.querySelector('.mm-own-dot')
    if (el) wavedEls.push(el)
  }

  for (const el of wavedEls) {
    void el.offsetWidth // force reflow so a repeated wave restarts cleanly
    el.classList.add('mm-wave')
  }
  waveTimer = setTimeout(() => {
    for (const el of wavedEls) el.classList.remove('mm-wave')
    wavedEls = []
  }, 2700)
}

// ------------------------------------------------------------- lifecycle

onMounted(() => {
  ensureMap()
})

onBeforeUnmount(() => {
  clearTimeout(waveTimer)
  wavedEls = []
  // Stop any in-flight position tweens before tearing the map down.
  if (ownMarker) cancelTween(ownMarker)
  for (const marker of hunterMarkers.values()) cancelTween(marker)
  for (const marker of hiderMarkers.values()) cancelTween(marker)
  map?.remove()
  map = null
  zoneCircle = null
  pickedMarker = null
  ownMarker = null
  ownAccuracy = null
  ownDeadMarker = null
  hunterMarkers = new Map()
  hiderMarkers = new Map()
})

watch(
  () => [props.zoneCenter, props.zoneRadius],
  ([center, radius]) => setZone(center, radius),
)
watch(
  () => props.fitKey,
  () => fitZone(),
)
watch(
  () => props.picked,
  (picked) => setPickedMarker(picked),
)
watch(
  () => props.myPosition,
  (pos) => setOwn(pos),
)
// The own marker is created once with the initial baked in — patch it if the
// initial only becomes known after the first fix.
watch(
  () => props.ownInitial,
  (letter) => {
    ownMarker?.setIcon(ownIcon(letter, props.ownDead))
    setOwnDeadPin(props.ownDeadPin)
  },
)
// Capture state flips the own dot grey and places/removes the dead pin.
watch(
  () => props.ownDead,
  (dead) => {
    ownMarker?.setIcon(ownIcon(props.ownInitial, dead))
    if (ownAccuracy) {
      const color = dead ? COLORS.captured : COLORS.own
      ownAccuracy.setStyle({ color, fillColor: color })
    }
    setOwnDeadPin(props.ownDeadPin)
  },
)
watch(
  () => props.ownDeadPin,
  (pin) => setOwnDeadPin(pin),
)
watch(() => [props.hunters, props.hiders, props.capturedIds], redrawMarkers, { deep: true })
// Registered AFTER the redraw watcher: on a reveal the snapshot markers are
// updated (and re-iconed) first, then the wave plays on the fresh elements.
watch(
  () => props.revealSeq,
  () => playRevealWave(),
)

/** Exposed for the parent to trigger an initial centering. */
defineExpose({
  flyTo: (lat, lng, zoom = 16) => map?.flyTo([lat, lng], zoom),
  fitZone,
})
</script>

<style>
/* Marker styles are global (Leaflet injects plain DOM, no scoped attrs). */
.game-map {
  width: 100%;
  height: 100%;
  min-height: 260px;
  background: #0d0d0d;
  z-index: 0;
}

/* Manual-location mode: invite tapping. */
.game-map--locate.leaflet-grab {
  cursor: crosshair;
}

.mm-marker-wrap {
  background: transparent;
  border: none;
}

.mm-marker {
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

.mm-marker > span {
  transform: rotate(45deg);
  font-size: 11px;
  font-weight: 700;
  color: #101010;
  line-height: 1;
}

.mm-marker--pulse {
  animation: mm-pulse 1s ease-out infinite;
}

/* Continuous wave for live-exposed pins (out of zone): endless rings. */
.mm-marker--wave-live::after {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 3px solid var(--mm-color, #ffab00);
  animation: mm-reveal-wave 1.3s ease-out infinite;
  pointer-events: none;
}

.mm-own-dot {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--mm-color, #40c4ff);
  border: 3px solid #ffffff;
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.8);
  box-sizing: border-box;
}

/* Captured player: same dot, grey. */
.mm-own-dot--dead {
  border-color: rgba(255, 255, 255, 0.75);
}

.mm-own-dot > span {
  font-size: 9px;
  font-weight: 700;
  color: #101010;
  line-height: 1;
}

/* Captured pin: upright ✕ badge pinned to the teardrop's top-right corner
   (counter-rotates the parent's -45deg tilt). Higher specificity than
   `.mm-marker > span` so the badge overrides the glyph styles. */
.mm-marker .mm-x-badge {
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
  transform: rotate(45deg); /* upright against the parent's rotate(-45deg) */
}

/* Reveal wave: two expanding rings, tinted with the marker's own color. */
.mm-wave::after {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 3px solid var(--mm-color, #00e676);
  animation: mm-reveal-wave 1.3s ease-out 2;
  pointer-events: none;
}

@keyframes mm-reveal-wave {
  0% {
    transform: scale(0.5);
    opacity: 0.9;
  }
  100% {
    transform: scale(2.6);
    opacity: 0;
  }
}

@keyframes mm-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 171, 0, 0.7);
  }
  70% {
    box-shadow: 0 0 0 14px rgba(255, 171, 0, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 171, 0, 0);
  }
}
</style>
