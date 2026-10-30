<template>
  <q-page class="room-page column">
    <!-- Room header -->
    <q-toolbar class="room-toolbar">
      <q-btn flat round dense icon="logout" @click="leave">
        <q-tooltip>Raum verlassen</q-tooltip>
      </q-btn>
      <q-toolbar-title class="row items-center q-gutter-x-sm">
        <span class="text-weight-bold room-code">{{ roomCode }}</span>
        <q-btn flat round dense size="sm" icon="content_copy" @click="copyCode">
          <q-tooltip>Code &amp; Link kopieren</q-tooltip>
        </q-btn>
        <span class="status-pill" :class="`status-pill--${status}`">{{ statusLabel }}</span>
      </q-toolbar-title>
      <q-icon
        :name="store.connected ? 'wifi' : 'wifi_off'"
        :color="store.connected ? 'positive' : 'negative'"
        size="22px"
      >
        <q-tooltip>{{ store.connected ? 'Verbunden' : 'Getrennt' }}</q-tooltip>
      </q-icon>
    </q-toolbar>

    <!-- HUD: single thumb-scrollable row of flat chips -->
    <div v-if="status === 'active'" class="hud-row">
      <span v-if="isHiding" class="hud-chip hud-chip--amber">
        <q-icon name="hourglass_top" size="14px" />
        Verstecken {{ formatClock(tick?.hideRemaining ?? 0) }}
      </span>
      <span class="hud-chip">
        <q-icon name="timer" size="14px" />
        {{ formatClock(tick?.timeRemaining ?? 0) }}
      </span>
      <span v-if="!isHiding" class="hud-chip hud-chip--green">
        <q-icon name="adjust" size="14px" />
        Zone {{ Math.round(zoneRadius) }} m
      </span>
      <span v-if="!isHiding" class="hud-chip hud-chip--orange">
        <q-icon name="compress" size="14px" />
        Schrumpfen in {{ tick?.nextShrinkIn ?? '–' }} s
      </span>
      <span v-if="!isHiding" class="hud-chip hud-chip--purple">
        <q-icon name="visibility" size="14px" />
        {{ amHunter ? 'Aufdecken in' : 'Enttarnung in' }} {{ nextRevealIn }} s
      </span>
      <span class="hud-chip" :class="gpsChipClass">
        <q-icon name="gps_fixed" size="14px" />
        {{ gpsChipLabel }}
      </span>
    </div>

    <!-- Hiding phase banner -->
    <q-banner
      v-if="status === 'active' && isHiding && !me?.captured"
      class="banner banner--amber q-mb-sm"
      rounded
    >
      <template #avatar>
        <q-icon name="directions_run" />
      </template>
      <template v-if="amHider"
        >VERSTECK DICH! Die Jagd beginnt in {{ tick?.hideRemaining ?? 0 }} s.</template
      >
      <template v-else
        >Die Verstecker suchen sich ihre Plätze. Die Jagd beginnt in
        {{ tick?.hideRemaining ?? 0 }} s.</template
      >
    </q-banner>

    <!-- Proximity alert banner (hiders) -->
    <q-banner
      v-if="status === 'active' && amHider && !me?.captured && store.proximity.inRange"
      class="banner banner--red q-mb-sm proximity-banner"
      rounded
    >
      <template #avatar>
        <q-icon name="warning" />
      </template>
      Jäger in der Nähe — leise bleiben und nichts bewegen!
    </q-banner>

    <!-- Captured banner -->
    <q-banner v-if="me?.captured" class="banner banner--grey q-mb-sm" rounded>
      <template #avatar>
        <q-icon name="sports_score" color="negative" />
      </template>
      Du wurdest von <b>{{ capturerName }}</b> gefunden. Genieße den Rest des Matches als Zuschauer.
    </q-banner>

    <!-- Map -->
    <div class="map-holder" :class="{ 'map-holder--short': status !== 'active' }">
      <GameMap
        :zone-center="mapZoneCenter"
        :zone-radius="zoneRadius"
        :mode="zonePickArmed ? 'picker' : 'view'"
        :picked="zonePickArmed ? zonePick : null"
        @update:picked="onZonePick"
        :hunters="store.hunterPositions"
        :hiders="visibleHiders"
        :captured-ids="capturedIds"
        :my-position="store.myPosition"
        :fit-key="fitKey"
        :follow="status === 'active'"
        :reveal-seq="store.revealSeq"
        :wave-own-pin="amHider"
        :own-initial="ownInitial"
        :own-dead="amCaptured"
        :own-dead-pin="ownDeadPin"
        :tap-to-locate="manualLocationActive"
        @locate="store.setManualLocation"
      />

      <!-- Map overlay panels: stacked, so they can never overlap -->
      <div class="map-overlay-stack">
        <!-- Host, lobby only: re-place the zone center on the map -->
        <div v-if="canPickZone" class="map-overlay-panel">
          <q-icon name="my_location" size="16px" color="grey-5">
            <q-tooltip>Zentrum der Zone verschieben</q-tooltip>
          </q-icon>
          <q-toggle
            v-model="zonePickArmed"
            dense
            dark
            size="sm"
            label="Zone verschieben"
            left-label
          >
            <q-tooltip
              >Nur in der Lobby: Tippe auf die Karte, um das Zentrum für alle zu verschieben; ziehe
              die ◎ Markierung zum Feinjustieren.</q-tooltip
            >
          </q-toggle>
        </div>

        <!-- Manual location (testing tool) — off by default -->
        <div class="map-overlay-panel">
          <q-icon name="science" size="16px" color="grey-5">
            <q-tooltip>Test-Werkzeuge</q-tooltip>
          </q-icon>
          <q-toggle
            v-model="manualEnabledProxy"
            dense
            dark
            size="sm"
            label="Manueller Standort"
            left-label
          >
            <q-tooltip
              >Nur zum Testen: ersetzt dein GPS durch Tippen auf der Karte. Standardmäßig aus — vor
              einem echten Spiel deaktivieren.</q-tooltip
            >
          </q-toggle>
          <q-btn-toggle
            v-if="manualEnabledProxy"
            v-model="manualModeProxy"
            dense
            no-caps
            unelevated
            toggle-color="primary"
            :options="[
              { label: 'GPS', value: false, icon: 'gps_fixed' },
              { label: 'Manuell', value: true, icon: 'touch_app' },
            ]"
          />
        </div>
      </div>

      <q-chip v-if="zonePickArmed" dense class="map-overlay-hint" color="dark" text-grey-3>
        Tippe auf die Karte, um das Zentrum der Zone zu setzen
      </q-chip>

      <q-chip
        v-if="manualLocationActive"
        dense
        class="map-overlay-hint map-overlay-hint--raised"
        color="dark"
        text-grey-3
      >
        Tippe auf die Karte, um deinen Standort zu setzen
      </q-chip>

      <q-chip
        v-if="screenMaySleep"
        dense
        class="map-overlay-hint map-overlay-hint--high"
        color="dark"
        text-amber-5
      >
        Display kann ausgehen — dieser Browser kann es nicht wach halten
      </q-chip>
    </div>

    <div
      v-if="status === 'active'"
      class="row items-center q-gutter-x-md text-caption text-grey-6 q-py-xs"
    >
      <span><span class="legend-dot" style="background: #ff5252" /> Jäger</span>
      <span v-if="amHunter"
        ><span class="legend-dot" style="background: #00e676" /> Verstecker (Snapshot)</span
      >
      <span v-if="amHunter"
        ><span class="legend-dot" style="background: #ffab00" /> Enttarnt (live)</span
      >
      <span><span class="legend-dot" style="background: #40c4ff" /> Du</span>
    </div>

    <!-- LOBBY -->
    <template v-if="status === 'lobby'">
      <q-card flat class="q-mt-md">
        <q-card-section class="q-pb-none text-subtitle1 text-weight-medium">
          Lobby · {{ players.length }} Spieler
        </q-card-section>
        <q-card-section class="q-pt-sm">
          <q-list dense separator>
            <q-item v-for="p in players" :key="p.id">
              <q-item-section avatar>
                <q-icon
                  :name="p.role === 'hunter' ? 'radar' : 'visibility_off'"
                  :color="p.role === 'hunter' ? 'negative' : 'positive'"
                />
              </q-item-section>
              <q-item-section>
                <q-item-label>
                  {{ p.name }}
                  <q-icon
                    v-if="p.id === roomState?.hostId"
                    name="workspace_premium"
                    size="16px"
                    color="amber-7"
                  >
                    <q-tooltip>Host</q-tooltip>
                  </q-icon>
                  <q-badge v-if="p.id === myPlayerId" class="q-ml-sm">du</q-badge>
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-icon name="circle" :color="p.connected ? 'positive' : 'grey-8'" size="10px">
                  <q-tooltip>{{ p.connected ? 'Verbunden' : 'Getrennt' }}</q-tooltip>
                </q-icon>
              </q-item-section>
            </q-item>
          </q-list>

          <div class="text-caption text-grey-6 q-mt-sm">
            Teile den Code <b>{{ roomCode }}</b> — Freunde öffnen die App, tippen auf „Mit Code
            beitreten“ und wählen eine Seite.
          </div>

          <q-btn-toggle
            v-model="myRoleProxy"
            dark
            spread
            rounded
            no-caps
            class="q-mt-md"
            toggle-color="primary"
            :options="[
              { label: 'Als Jäger spielen', value: 'hunter', icon: 'radar' },
              { label: 'Als Verstecker spielen', value: 'hider', icon: 'visibility_off' },
            ]"
          />
        </q-card-section>
      </q-card>

      <!-- Everyone else sees the host's match configuration read-only -->
      <SettingsSummary v-if="!isHost" :settings="settings" class="q-mt-md" />
      <SettingsPanel v-else v-model="settingsProxy" class="q-mt-md" />
    </template>

    <!-- ACTIVE -->
    <template v-else-if="status === 'active'">
      <q-card flat class="q-mt-md">
        <q-card-section v-if="amHunter" class="q-gutter-y-sm">
          <div class="text-subtitle1 text-weight-medium">Jagd läuft</div>
          <div class="text-body2 text-grey-5">
            Verstecker-Positionen werden alle {{ settings?.hiderRevealInterval }} s aufgedeckt.
            Jeder Verstecker außerhalb der Zone wird live verfolgt (orange Markierungen).
          </div>
          <div>
            <q-chip
              v-for="h in hiders"
              :key="h.id"
              :color="h.captured ? 'grey-8' : 'positive'"
              :text-color="h.captured ? 'grey-4' : 'black'"
              icon="person"
            >
              {{ h.name }}{{ h.captured ? ' — gefunden' : '' }}
            </q-chip>
          </div>
        </q-card-section>

        <q-card-section v-else-if="!me?.captured" class="q-gutter-y-sm">
          <div class="text-subtitle1 text-weight-medium">Bleib versteckt</div>
          <div class="text-body2 text-grey-5">
            Du hörst einen Piepton, wenn ein Jäger dir näher als
            {{ settings?.proximityDistanceMeters }} m kommt.
          </div>
        </q-card-section>
      </q-card>
    </template>

    <!-- ENDED -->
    <template v-else-if="status === 'ended'">
      <q-card flat class="q-mt-md">
        <q-card-section class="text-center q-gutter-y-sm">
          <q-icon
            :name="gameOver?.winner === 'hiders' ? 'visibility_off' : 'radar'"
            :color="gameOver?.winner === 'hiders' ? 'positive' : 'negative'"
            size="48px"
          />
          <div class="text-h5 text-weight-bold">
            {{ gameOver?.winner === 'hiders' ? 'Verstecker gewinnen!' : 'Jäger gewinnen!' }}
          </div>
          <div class="text-body2 text-grey-5">{{ gameOver?.reason }}</div>
        </q-card-section>
      </q-card>
    </template>

    <!-- Capture dialog (hider picks who found them) -->
    <q-dialog v-model="captureOpen">
      <q-card dark class="dialog-card">
        <q-card-section>
          <div class="text-h6">Wer hat dich gefunden?</div>
        </q-card-section>
        <q-card-section>
          <q-list separator>
            <q-item
              v-for="h in connectedHunters"
              :key="h.id"
              clickable
              v-ripple
              @click="reportCapture(h)"
            >
              <q-item-section avatar>
                <q-icon name="radar" color="negative" />
              </q-item-section>
              <q-item-section>Gefunden von {{ h.name }}</q-item-section>
            </q-item>
          </q-list>
          <div v-if="connectedHunters.length === 0" class="text-caption text-grey-6 q-pa-sm">
            Gerade ist kein Jäger verbunden.
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Abbrechen" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Game over dialog -->
    <q-dialog v-model="overDialogOpen">
      <q-card dark class="dialog-card text-center">
        <q-card-section class="q-gutter-y-sm">
          <q-icon
            :name="gameOver?.winner === 'hiders' ? 'emoji_events' : 'military_tech'"
            :color="gameOver?.winner === 'hiders' ? 'positive' : 'negative'"
            size="56px"
          />
          <div class="text-h5 text-weight-bold">
            {{ gameOver?.winner === 'hiders' ? 'Verstecker gewinnen!' : 'Jäger gewinnen!' }}
          </div>
          <div class="text-body2 text-grey-5">{{ gameOver?.reason }}</div>
        </q-card-section>
        <q-card-actions align="center">
          <q-btn flat no-caps label="Schließen" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Bottom action bar: the one thumb-reachable primary action per state -->
    <div v-if="bottomBar" class="bottom-bar">
      <template v-if="bottomBar === 'start'">
        <q-btn
          class="full-width"
          color="primary"
          size="lg"
          unelevated
          no-caps
          icon="play_arrow"
          label="Spiel starten"
          :disable="!canStart"
          @click="start"
        />
        <div v-if="canStartHint" class="text-caption text-grey-6 text-center q-pt-xs">
          {{ canStartHint }}
        </div>
      </template>
      <q-btn
        v-else-if="bottomBar === 'capture'"
        class="full-width"
        color="negative"
        size="lg"
        unelevated
        no-caps
        icon="sports_score"
        label="Ich wurde gefunden — Fang melden"
        @click="captureOpen = true"
      />
      <q-btn
        v-else-if="bottomBar === 'reset'"
        class="full-width"
        color="primary"
        size="lg"
        unelevated
        no-caps
        icon="replay"
        label="Zurück zur Lobby"
        @click="reset"
      />
      <div v-else-if="bottomBar === 'waiting'" class="text-body2 text-grey-5 text-center">
        Warte darauf, dass der Host das Spiel startet…
      </div>
      <div v-else-if="bottomBar === 'ended-wait'" class="text-body2 text-grey-5 text-center">
        Der Host kann ein Rematch starten.
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuasar } from 'quasar'

import GameMap from '@/components/GameMap.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import SettingsSummary from '@/components/SettingsSummary.vue'
import { useGameStore } from '@/stores/game'
import { wakeLockActive } from '@/services/wakeLock'

const route = useRoute()
const router = useRouter()
const $q = useQuasar()
const store = useGameStore()

const captureOpen = ref(false)
const overDialogOpen = ref(false)
const fitKey = ref(0)
let errorWatch = null
let overWatch = null
let statusWatch = null

const roomCode = computed(() => route.params.code?.toUpperCase() || '')
const roomState = computed(() => store.roomState)
const status = computed(() => store.status)
// While we are in a room (lobby/match) the app holds a screen wake lock; if
// the browser cannot grant it (unsupported — e.g. older iOS — or denied by
// battery saver), tell the player their screen may still turn off.
const screenMaySleep = computed(
  () => (status.value === 'lobby' || status.value === 'active') && !wakeLockActive.value,
)
const settings = computed(() => store.settings)
const zoneRadius = computed(() => store.zoneRadius)
const zoneCenter = computed(() => store.zoneCenter)
const myPlayerId = computed(() => store.myPlayerId)
const isHost = computed(() => store.isHost)
const amHunter = computed(() => store.amHunter)
const amHider = computed(() => store.amHider)
const players = computed(() => store.players)
const hiders = computed(() => store.hiders)
const me = computed(() => store.me)
const gameOver = computed(() => store.gameOver)
const tick = computed(() => store.tick)

const connectedHunters = computed(() => store.hunters.filter((p) => p.connected))
const capturedIds = computed(() => hiders.value.filter((p) => p.captured).map((p) => p.id))
const capturerName = computed(
  () => players.value.find((p) => p.id === me.value?.capturedBy)?.name || 'einem Jäger',
)

const canStart = computed(() => {
  const rs = roomState.value
  if (!rs || !isHost.value) return false
  const active = players.value.filter((p) => p.connected)
  return active.some((p) => p.role === 'hunter') && active.some((p) => p.role === 'hider')
})

const canStartHint = computed(() => {
  if (canStart.value) return ''
  const active = players.value.filter((p) => p.connected)
  if (!active.some((p) => p.role === 'hunter')) return 'Mindestens ein Jäger wird gebraucht.'
  if (!active.some((p) => p.role === 'hider')) return 'Mindestens ein Verstecker wird gebraucht.'
  return ''
})

const isHiding = computed(() => status.value === 'active' && tick.value?.phase === 'hiding')

// The single thumb-reachable primary action for the current state — pinned to
// the bottom of the screen (lobby: start, active hider: report capture, …).
const bottomBar = computed(() => {
  if (status.value === 'lobby') return isHost.value ? 'start' : 'waiting'
  if (status.value === 'active') {
    return amHider.value && !me.value?.captured ? 'capture' : null
  }
  if (status.value === 'ended') return isHost.value ? 'reset' : 'ended-wait'
  return null
})

// Manual location (testing): feature switch + live GPS/Manual mode.
const manualEnabledProxy = computed({
  get: () => store.manualEnabled,
  set: (v) => store.setManualEnabled(v),
})
const manualModeProxy = computed({
  get: () => store.manualMode,
  set: (v) => store.setManualMode(v),
})
const manualLocationActive = computed(() => store.manualEnabled && store.manualMode)

// ----------------------------------------------------- host: move the zone

// In the lobby the host can re-place the zone center: arming "Move zone"
// switches the map to picker mode — taps (and drags of the ◎ marker) commit
// the new center for everyone via room:set_zone_center.
const zonePickArmed = ref(false)
const zonePick = ref(null)
const canPickZone = computed(() => isHost.value && status.value === 'lobby')
// While picking, the zone circle previews at the tentative spot; once the
// server round-trips, zoneCenter === zonePick and nothing jumps.
const mapZoneCenter = computed(() => (zonePickArmed.value && zonePick.value) || zoneCenter.value)
function onZonePick(center) {
  zonePick.value = center
  store.setZoneCenter(center).catch((e) => {
    $q.notify({ type: 'negative', message: e.message })
    zonePickArmed.value = false
    zonePick.value = null
  })
}
// Leaving the lobby (game start / room exit) disarms zone picking.
watch(status, (next) => {
  if (next !== 'lobby') {
    zonePickArmed.value = false
    zonePick.value = null
  }
})

// Hider pins on the map:
// - in the lobby everyone sees everyone,
// - hunters see the full hider list (periodic reveals + live-exposed),
// - hiders see their TEAM live at all times — everyone except themselves.
const visibleHiders = computed(() => {
  if (status.value === 'lobby') return store.hiderPositions
  if (amHunter.value) return store.hiderPositions
  if (amHider.value) return store.hiderPositions.filter((h) => h.id !== store.myPlayerId)
  return []
})

const ownInitial = computed(() => (store.me?.name || '').trim().charAt(0).toUpperCase())

// Captured hider: dead pin at the found spot + grey live tracking.
const amCaptured = computed(() => !!store.me?.captured)
const ownDeadPin = computed(() => {
  if (!amCaptured.value) return null
  if (store.deadPin) return store.deadPin
  // Fallback (e.g. page refresh after capture): the frozen position the
  // server keeps on the own team-list entry.
  const own = store.hiderPositions.find((h) => h.id === store.myPlayerId)
  return own && own.lat != null ? { lat: own.lat, lng: own.lng } : null
})

// Server-authoritative: the tick payload carries `nextRevealIn`, so both
// hunters and hiders count down to the same reveal schedule.
const nextRevealIn = computed(() => tick.value?.nextRevealIn ?? '–')

const statusLabel = computed(() =>
  status.value === 'lobby' ? 'LOBBY' : status.value === 'active' ? 'LIVE' : 'BEENDET',
)

const gpsChipLabel = computed(() => {
  if (store.manualMode) return 'Manuell'
  if (store.gpsError) return 'Kein GPS'
  if (!store.myPosition) return 'Warte…'
  return `±${Math.round(store.myPosition.accuracy)} m`
})

const gpsChipClass = computed(() => {
  if (store.manualMode) return 'hud-chip--teal'
  if (store.gpsError) return 'hud-chip--red'
  if (store.gpsWeak) return 'hud-chip--warn'
  return ''
})

const myRoleProxy = computed({
  get: () => me.value?.role || 'hunter',
  set: (role) => store.setRole(role),
})

const settingsProxy = computed({
  get: () => settings.value || {},
  set: (patch) => {
    store
      .updateSettings(patch)
      .catch((err) => $q.notify({ type: 'negative', message: err.message }))
  },
})

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function copyCode() {
  const url = `${window.location.origin}${window.location.pathname}#/room/${roomCode.value}`
  const text = `Komm in meinen Manhunt-Raum: Code ${roomCode.value} → ${url}`
  navigator.clipboard?.writeText(text).then(
    () => $q.notify({ type: 'positive', message: 'Code & Link kopiert' }),
    () => $q.notify({ message: `Raumcode: ${roomCode.value}` }),
  )
}

async function start() {
  try {
    await store.startGame()
    fitKey.value++
  } catch (err) {
    $q.notify({ type: 'negative', message: err.message })
  }
}

function reset() {
  store.resetGame().catch((err) => $q.notify({ type: 'negative', message: err.message }))
}

function reportCapture(hunter) {
  captureOpen.value = false
  store.captureMe(hunter.id).catch((err) => $q.notify({ type: 'negative', message: err.message }))
}

function leave() {
  store.leaveRoom()
  router.push('/')
}

// ------------------------------------------------------------ lifecycle

onMounted(async () => {
  const code = roomCode.value

  // If we were in a different room (e.g. navigating between rooms), leave it.
  if (roomState.value && roomState.value.code !== code) store.leaveRoom()

  // Fresh page load / refresh: recover the session by re-joining with the
  // stored name (the server reuses the disconnected player entry).
  if (!roomState.value || roomState.value.code !== code) {
    const name = (localStorage.getItem('manhunt:name') || '').trim()
    const role = localStorage.getItem('manhunt:role') || 'hunter'
    if (!name) {
      $q.notify({ type: 'warning', message: 'Gib zuerst deinen Namen ein' })
      router.replace('/')
      return
    }
    try {
      await store.joinRoom({ roomCode: code, playerName: name, role })
    } catch (err) {
      $q.notify({ type: 'negative', message: err.message })
      router.replace('/')
      return
    }
  }

  store.startTracking()

  errorWatch = watch(
    () => store.lastError,
    (msg) => {
      if (msg) {
        $q.notify({ type: 'negative', message: msg })
        store.clearError()
      }
    },
  )

  overWatch = watch(
    () => store.gameOver,
    (over) => {
      if (over) overDialogOpen.value = true
    },
  )

  // Force an immediate position send when a match goes live.
  statusWatch = watch(
    () => store.status,
    (next) => {
      if (next === 'active' && store.myPosition) {
        store.sendLocation(store.myPosition, true)
        fitKey.value++
      }
    },
  )
})

onBeforeUnmount(() => {
  errorWatch?.()
  overWatch?.()
  statusWatch?.()
  store.stopTracking()
})
</script>

<style scoped>
.room-page {
  /* clears the fixed bottom action bar + screen-bound gutters */
  padding: 0 12px 116px;
}

.room-toolbar {
  position: sticky;
  top: 0;
  z-index: 1200;
  background: rgba(16, 20, 19, 0.88);
  backdrop-filter: blur(12px);
  /* span edge-to-edge despite the page gutters (negative margins) */
  margin: 0 -12px;
  padding: 0 12px;
}

.room-code {
  letter-spacing: 0.3em;
  font-size: 1.25rem;
}

.status-pill {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.status-pill--lobby {
  background: rgba(33, 150, 243, 0.16);
  color: #64b5f6;
}

.status-pill--active {
  background: rgba(0, 230, 118, 0.14);
  color: #3dfa94;
}

.status-pill--ended {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.6);
}

.map-holder {
  position: relative;
  height: min(58vh, 560px);
  min-height: 300px;
  /* Full-bleed: cancel the page gutters — the map belongs edge-to-edge. */
  margin: 0 -12px;
  overflow: hidden;
}

.map-holder--short {
  height: min(42vh, 420px);
}

/* Overlay panels live in one stacked column — they can never overlap. */
.map-overlay-stack {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: calc(100% - 16px);
}

.map-overlay-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(16, 20, 19, 0.86);
  backdrop-filter: blur(8px);
  max-width: 100%;
}

.map-overlay-hint {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1100;
  pointer-events: none;
  opacity: 0.92;
}

.map-overlay-hint--raised {
  bottom: 46px;
}

.map-overlay-hint--high {
  bottom: 80px;
}

.hud-row {
  display: flex;
  flex-wrap: wrap; /* chips break to the next line — never wider than the screen */
  gap: 8px;
  margin: 2px 0 8px;
  padding: 2px;
  max-width: 100%;
}

.hud-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 13px;
  border-radius: 999px;
  background: var(--mm-surface, rgba(255, 255, 255, 0.045));
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.hud-chip--amber {
  background: rgba(255, 171, 0, 0.14);
  color: #ffc862;
}

.hud-chip--green {
  background: rgba(0, 230, 118, 0.12);
  color: #4dffa0;
}

.hud-chip--orange {
  background: rgba(255, 138, 101, 0.14);
  color: #ff9b7a;
}

.hud-chip--purple {
  background: rgba(206, 147, 216, 0.14);
  color: #dca6e8;
}

.hud-chip--teal {
  background: rgba(77, 214, 196, 0.14);
  color: #5fe0cd;
}

.hud-chip--red {
  background: rgba(255, 82, 82, 0.16);
  color: #ff8a80;
}

.hud-chip--warn {
  background: rgba(255, 210, 87, 0.14);
  color: #ffd75e;
}

.banner--amber {
  background: rgba(255, 171, 0, 0.14);
  color: #ffd75e;
}

.banner--red {
  background: rgba(255, 82, 82, 0.16);
  color: #ff8a80;
}

.banner--grey {
  background: var(--mm-surface-strong, rgba(255, 255, 255, 0.09));
  color: rgba(255, 255, 255, 0.75);
}

.bottom-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1250;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  background: rgba(16, 20, 19, 0.92);
  backdrop-filter: blur(12px);
}

.dialog-card {
  width: min(92vw, 340px);
}

.proximity-banner {
  animation: proximity-pulse 1s ease-in-out infinite;
}

.legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}

@keyframes proximity-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
</style>
