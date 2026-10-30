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
    }).addTo(map)
  } else {
    ownMarker.setLatLng([pos.lat, pos.lng])
    ownAccuracy.setLatLng([pos.lat, pos.lng])
    ownAccuracy.setRadius(pos.accuracy || 0)
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
  markerLayer.clearLayers()
  hiderMarkers = new Map()
  const captured = new Set(props.capturedIds)

  for (const h of props.hunters) {
    if (h.lat == null || h.lng == null) continue
    L.marker([h.lat, h.lng], { icon: roleIcon(COLORS.hunter, { glyph: initial(h.name) }) })
      .bindTooltip(`Hunter ${h.name}`)
      .addTo(markerLayer)
  }

  for (const h of props.hiders) {
    if (h.lat == null || h.lng == null) continue
    const isDead = captured.has(h.id)
    const color = isDead ? COLORS.captured : h.isExposedLive ? COLORS.exposed : COLORS.hider
    const marker = L.marker([h.lat, h.lng], {
      icon: roleIcon(color, {
        pulse: h.isExposedLive && !isDead,
        // Exposed pins wave continuously instead of only on reveals.
        waveLive: h.isExposedLive && !isDead,
        dead: isDead,
        glyph: initial(h.name),
      }),
    })
      .bindTooltip(`${h.name}${isDead ? ' (found)' : h.isExposedLive ? ' — LIVE' : ''}`)
      .addTo(markerLayer)
    hiderMarkers.set(h.id, marker)
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
  map?.remove()
  map = null
  zoneCircle = null
  pickedMarker = null
  ownMarker = null
  ownAccuracy = null
  ownDeadMarker = null
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
// rebuilt first, then the wave plays on the fresh elements.
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
