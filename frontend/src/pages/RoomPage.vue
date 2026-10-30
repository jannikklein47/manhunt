<template>
  <q-page class="column q-pb-lg">
    <!-- Room header -->
    <q-toolbar class="q-px-none">
      <q-btn flat round dense icon="logout" @click="leave">
        <q-tooltip>Leave room</q-tooltip>
      </q-btn>
      <q-toolbar-title class="row items-center q-gutter-x-sm">
        <span class="text-weight-bold room-code">{{ roomCode }}</span>
        <q-btn flat round dense size="sm" icon="content_copy" @click="copyCode">
          <q-tooltip>Copy code &amp; link</q-tooltip>
        </q-btn>
        <q-chip :color="statusColor" text-white dense>{{ statusLabel }}</q-chip>
      </q-toolbar-title>
      <q-icon
        :name="store.connected ? 'wifi' : 'wifi_off'"
        :color="store.connected ? 'positive' : 'negative'"
        size="22px"
      >
        <q-tooltip>{{ store.connected ? 'Connected' : 'Disconnected' }}</q-tooltip>
      </q-icon>
    </q-toolbar>

    <!-- HUD -->
    <div v-if="status === 'active'" class="row q-col-gutter-sm q-mb-sm">
      <q-chip v-if="isHiding" outline color="amber-7" icon="hourglass_top" class="hud-chip">
        Hide: {{ formatClock(tick?.hideRemaining ?? 0) }}
      </q-chip>
      <q-chip outline :color="isHiding ? 'grey-6' : 'white'" icon="timer" class="hud-chip">
        {{ formatClock(tick?.timeRemaining ?? 0) }}
      </q-chip>
      <q-chip v-if="!isHiding" outline color="green-5" icon="adjust" class="hud-chip">
        Zone {{ Math.round(zoneRadius) }} m
      </q-chip>
      <q-chip v-if="!isHiding" outline color="orange-5" icon="compress" class="hud-chip">
        Shrink in {{ tick?.nextShrinkIn ?? '–' }} s
      </q-chip>
      <q-chip v-if="!isHiding" outline color="purple-4" icon="visibility" class="hud-chip">
        {{ amHunter ? 'Reveal in' : 'Spotted in' }} {{ nextRevealIn }} s
      </q-chip>
      <q-chip outline :color="gpsChipColor" icon="gps_fixed" class="hud-chip">
        {{ gpsChipLabel }}
      </q-chip>
    </div>

    <!-- Hiding phase banner -->
    <q-banner
      v-if="status === 'active' && isHiding && !me?.captured"
      class="bg-amber-8 text-black q-mb-sm"
      rounded
    >
      <template #avatar>
        <q-icon name="directions_run" />
      </template>
      <template v-if="amHider"
        >GO HIDE! The hunt starts in {{ tick?.hideRemaining ?? 0 }}s.</template
      >
      <template v-else
        >Hiders are taking their positions. The hunt starts in
        {{ tick?.hideRemaining ?? 0 }}s.</template
      >
    </q-banner>

    <!-- Proximity alert banner (hiders) -->
    <q-banner
      v-if="status === 'active' && amHider && !me?.captured && store.proximity.inRange"
      class="bg-negative text-white q-mb-sm proximity-banner"
      rounded
    >
      <template #avatar>
        <q-icon name="warning" />
      </template>
      Hunter in range — keep quiet and stay still!
    </q-banner>

    <!-- Captured banner -->
    <q-banner v-if="me?.captured" class="bg-dark text-grey-3 q-mb-sm" rounded>
      <template #avatar>
        <q-icon name="sports_score" color="negative" />
      </template>
      You were found by <b>{{ capturerName }}</b
      >. Enjoy watching the rest of the match.
    </q-banner>

    <!-- Map -->
    <div class="map-holder" :class="{ 'map-holder--short': status !== 'active' }">
      <GameMap
        :zone-center="roomState?.zoneCenter"
        :zone-radius="zoneRadius"
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

      <!-- Manual location (testing tool) — off by default -->
      <div class="map-overlay-panel">
        <q-icon name="science" size="16px" color="grey-5">
          <q-tooltip>Testing tools</q-tooltip>
        </q-icon>
        <q-toggle
          v-model="manualEnabledProxy"
          dense
          dark
          size="sm"
          label="Manual location"
          left-label
        >
          <q-tooltip
            >Testing only: replaces your GPS with tap-the-map positioning. Off by default — disable
            it before a real game.</q-tooltip
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
            { label: 'Manual', value: true, icon: 'touch_app' },
          ]"
        />
      </div>

      <q-chip v-if="manualLocationActive" dense class="map-overlay-hint" color="dark" text-grey-3>
        Tap the map to set your position
      </q-chip>

      <q-chip
        v-if="screenMaySleep"
        dense
        class="map-overlay-hint map-overlay-hint--raised"
        color="dark"
        text-amber-5
      >
        Screen may turn off — this browser can't keep it awake
      </q-chip>
    </div>

    <div
      v-if="status === 'active'"
      class="row items-center q-gutter-x-md text-caption text-grey-6 q-px-sm q-py-xs"
    >
      <span><span class="legend-dot" style="background: #ff5252" /> Hunters</span>
      <span v-if="amHunter"
        ><span class="legend-dot" style="background: #00e676" /> Hiders (snapshot)</span
      >
      <span v-if="amHunter"
        ><span class="legend-dot" style="background: #ffab00" /> Exposed (live)</span
      >
      <span><span class="legend-dot" style="background: #40c4ff" /> You</span>
    </div>

    <!-- LOBBY -->
    <template v-if="status === 'lobby'">
      <q-card flat bordered class="q-mt-md">
        <q-card-section class="q-pb-none text-subtitle1 text-weight-medium">
          Lobby · {{ players.length }} player{{ players.length === 1 ? '' : 's' }}
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
                  <q-badge v-if="p.id === myPlayerId" class="q-ml-sm">you</q-badge>
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-icon
                  :name="p.connected ? 'circle' : 'circle'"
                  :color="p.connected ? 'positive' : 'grey-8'"
                  size="10px"
                >
                  <q-tooltip>{{ p.connected ? 'Connected' : 'Disconnected' }}</q-tooltip>
                </q-icon>
              </q-item-section>
            </q-item>
          </q-list>

          <div class="text-caption text-grey-6 q-mt-sm">
            Share the code <b>{{ roomCode }}</b> — friends open the app, tap “Join with code” and
            pick a side.
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
              { label: 'Play as Hunter', value: 'hunter', icon: 'radar' },
              { label: 'Play as Hider', value: 'hider', icon: 'visibility_off' },
            ]"
          />
        </q-card-section>
      </q-card>

      <!-- Host controls -->
      <template v-if="isHost">
        <SettingsPanel v-model="settingsProxy" class="q-mt-md" />
        <q-btn
          class="q-mt-md"
          color="primary"
          size="lg"
          unelevated
          no-caps
          icon="play_arrow"
          label="Start game"
          :disable="!canStart"
          @click="start"
        />
        <div v-if="canStartHint" class="text-caption text-grey-6 q-mt-xs text-center">
          {{ canStartHint }}
        </div>
      </template>
      <div v-else class="text-caption text-grey-6 q-mt-md text-center">
        Waiting for the host to start the game…
      </div>
    </template>

    <!-- ACTIVE -->
    <template v-else-if="status === 'active'">
      <q-card flat bordered class="q-mt-md">
        <q-card-section v-if="amHunter" class="q-gutter-y-sm">
          <div class="text-subtitle1 text-weight-medium">Hunt in progress</div>
          <div class="text-body2 text-grey-5">
            Hider positions are revealed every {{ settings?.hiderRevealInterval }} s. Any hider
            outside the zone is tracked live (orange markers).
          </div>
          <div>
            <q-chip
              v-for="h in hiders"
              :key="h.id"
              :color="h.captured ? 'grey-8' : 'positive'"
              :text-color="h.captured ? 'grey-4' : 'black'"
              icon="person"
            >
              {{ h.name }}{{ h.captured ? ' — found' : '' }}
            </q-chip>
          </div>
        </q-card-section>

        <q-card-section v-else-if="!me?.captured" class="q-gutter-y-sm">
          <div class="text-subtitle1 text-weight-medium">Stay hidden</div>
          <div class="text-body2 text-grey-5">
            You hear a beep when a hunter gets within {{ settings?.proximityDistanceMeters }} m of
            you.
          </div>
          <q-btn
            color="negative"
            unelevated
            no-caps
            icon="sports_score"
            label="I've been found — report capture"
            @click="captureOpen = true"
          />
        </q-card-section>
      </q-card>
    </template>

    <!-- ENDED -->
    <template v-else-if="status === 'ended'">
      <q-card flat bordered class="q-mt-md">
        <q-card-section class="text-center q-gutter-y-sm">
          <q-icon
            :name="gameOver?.winner === 'hiders' ? 'visibility_off' : 'radar'"
            :color="gameOver?.winner === 'hiders' ? 'positive' : 'negative'"
            size="48px"
          />
          <div class="text-h5 text-weight-bold">
            {{ gameOver?.winner === 'hiders' ? 'Hiders win!' : 'Hunters win!' }}
          </div>
          <div class="text-body2 text-grey-5">{{ gameOver?.reason }}</div>
          <div v-if="isHost" class="row q-gutter-sm justify-center q-mt-sm">
            <q-btn
              color="primary"
              unelevated
              no-caps
              icon="replay"
              label="Back to lobby"
              @click="reset"
            />
          </div>
          <div v-else class="text-caption text-grey-6">The host can start a rematch.</div>
        </q-card-section>
      </q-card>
    </template>

    <!-- Capture dialog (hider picks who found them) -->
    <q-dialog v-model="captureOpen">
      <q-card style="min-width: 300px" dark>
        <q-card-section>
          <div class="text-h6">Who found you?</div>
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
              <q-item-section>Found by {{ h.name }}</q-item-section>
            </q-item>
          </q-list>
          <div v-if="connectedHunters.length === 0" class="text-caption text-grey-6 q-pa-sm">
            No hunters connected right now.
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Game over dialog -->
    <q-dialog v-model="overDialogOpen">
      <q-card style="min-width: 300px" dark class="text-center">
        <q-card-section class="q-gutter-y-sm">
          <q-icon
            :name="gameOver?.winner === 'hiders' ? 'emoji_events' : 'military_tech'"
            :color="gameOver?.winner === 'hiders' ? 'positive' : 'negative'"
            size="56px"
          />
          <div class="text-h5 text-weight-bold">
            {{ gameOver?.winner === 'hiders' ? 'Hiders win!' : 'Hunters win!' }}
          </div>
          <div class="text-body2 text-grey-5">{{ gameOver?.reason }}</div>
        </q-card-section>
        <q-card-actions align="center">
          <q-btn flat no-caps label="Close" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuasar } from 'quasar'

import GameMap from '@/components/GameMap.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
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
  () => players.value.find((p) => p.id === me.value?.capturedBy)?.name || 'a hunter',
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
  if (!active.some((p) => p.role === 'hunter')) return 'Need at least one hunter.'
  if (!active.some((p) => p.role === 'hider')) return 'Need at least one hider.'
  return ''
})

const isHiding = computed(() => status.value === 'active' && tick.value?.phase === 'hiding')

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
  status.value === 'lobby' ? 'LOBBY' : status.value === 'active' ? 'LIVE' : 'ENDED',
)
const statusColor = computed(() =>
  status.value === 'lobby' ? 'blue-8' : status.value === 'active' ? 'positive' : 'grey-8',
)

const gpsChipLabel = computed(() => {
  if (store.manualMode) return 'Manual'
  if (store.gpsError) return 'No GPS'
  if (!store.myPosition) return 'Waiting…'
  return `±${Math.round(store.myPosition.accuracy)} m`
})

const gpsChipColor = computed(() => {
  if (store.manualMode) return 'teal-6'
  if (store.gpsError) return 'negative'
  if (store.gpsWeak) return 'warning'
  return 'grey-6'
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
  const text = `Join my Manhunt room: code ${roomCode.value} → ${url}`
  navigator.clipboard?.writeText(text).then(
    () => $q.notify({ type: 'positive', message: 'Code & link copied' }),
    () => $q.notify({ message: `Room code: ${roomCode.value}` }),
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
      $q.notify({ type: 'warning', message: 'Enter your name first' })
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
.room-code {
  letter-spacing: 0.3em;
  font-size: 1.3rem;
}

.map-holder {
  position: relative;
  height: 52vh;
  min-height: 320px;
  border-radius: 8px;
  overflow: hidden;
}

.map-holder--short {
  height: 42vh;
}

.map-overlay-panel {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1100;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: 18px;
  background: rgba(20, 20, 20, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(4px);
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

.hud-chip {
  font-variant-numeric: tabular-nums;
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
