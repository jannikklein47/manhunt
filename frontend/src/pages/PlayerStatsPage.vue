<template>
  <q-page class="player-page column q-pa-md">
    <q-toolbar class="q-px-none">
      <q-btn flat round dense icon="arrow_back" @click="$router.push('/leaderboard')" />
      <q-toolbar-title class="text-h6 ellipsis">{{ displayName }}</q-toolbar-title>
      <q-btn flat round dense icon="refresh" :loading="loading" @click="load" />
    </q-toolbar>

    <div v-if="error" class="text-negative q-my-lg text-center">
      <q-icon name="person_off" size="32px" />
      <div class="q-mt-sm">{{ error }}</div>
      <q-btn
        class="q-mt-md"
        outline
        no-caps
        color="secondary"
        label="Zur Bestenliste"
        @click="$router.push('/leaderboard')"
      />
    </div>

    <div v-else-if="loading" class="col column items-center justify-center">
      <q-spinner-dots size="48px" color="primary" />
    </div>

    <template v-else>
      <!-- Headline numbers -->
      <div class="stat-grid q-mb-md">
        <div class="stat-card rounded-borders">
          <div class="text-h4 text-weight-bold">{{ s.matches }}</div>
          <div class="text-caption text-grey-5">Spiele</div>
        </div>
        <div class="stat-card rounded-borders">
          <div class="text-h4 text-weight-bold text-amber">{{ s.wins }}</div>
          <div class="text-caption text-grey-5">Siege</div>
        </div>
        <div class="stat-card rounded-borders">
          <div class="text-h4 text-weight-bold">{{ winRate }}%</div>
          <div class="text-caption text-grey-5">Siegesquote</div>
        </div>
        <div class="stat-card rounded-borders">
          <div class="text-h4 text-weight-bold">{{ pctLabel(s.avgSurvivedPct) }}</div>
          <div class="text-caption text-grey-5">Ø Spielzeit überlebt</div>
        </div>
        <div class="stat-card rounded-borders">
          <div class="text-h4 text-weight-bold">{{ pctLabel(s.avgCatchPct) }}</div>
          <div class="text-caption text-grey-5">Ø Zeit pro Fang</div>
        </div>
        <div class="stat-card rounded-borders">
          <div class="text-h4 text-weight-bold">{{ kmLabel }}</div>
          <div class="text-caption text-grey-5">Gelaufen</div>
        </div>
      </div>

      <!-- Role split -->
      <div class="q-mb-md">
        <div class="text-caption text-grey-5 q-mb-xs">Als Verstecker ({{ s.hiderMatches }})</div>
        <div class="row q-gutter-sm">
          <q-chip dark color="green-9" text-color="white" icon="emoji_events">
            {{ s.timesSurvived }}× überlebt
          </q-chip>
          <q-chip dark color="deep-orange-10" text-color="white" icon="radar">
            {{ s.timesCaught }}× gefangen
          </q-chip>
          <q-chip dark color="orange-10" text-color="white" icon="visibility">
            {{ s.exposures }}× außerhalb
          </q-chip>
        </div>
        <div class="text-caption text-grey-5 q-mt-sm q-mb-xs">
          Als Jäger ({{ s.hunterMatches }})
        </div>
        <div class="row q-gutter-sm">
          <q-chip dark color="red-10" text-color="white" icon="sports_martial_arts">
            {{ s.captures }} {{ s.captures === 1 ? 'Fang' : 'Fänge' }}
          </q-chip>
        </div>
      </div>

      <!-- Recent matches -->
      <div class="text-caption text-grey-5 q-mb-xs">Letzte Spiele</div>
      <q-list class="col-shrink match-list q-gutter-y-sm">
        <q-item
          v-for="m in player.matches"
          :key="m.id"
          clickable
          class="match-item rounded-borders"
          @click="$router.push(`/replays/${m.id}`)"
        >
          <q-item-section avatar>
            <q-icon
              :name="m.won ? 'emoji_events' : m.captured ? 'radar' : 'close'"
              :color="m.won ? 'amber' : m.captured ? 'red' : 'grey-5'"
              size="28px"
            />
          </q-item-section>
          <q-item-section>
            <q-item-label class="text-weight-bold mm-mono">{{ m.lobbyCode }}</q-item-label>
            <q-item-label caption
              >{{ matchDate(m.startedAt) }} · {{ roleLabel(m.role) }}</q-item-label
            >
          </q-item-section>
          <q-item-section side>
            <div class="column items-end text-caption text-grey-5">
              <span :class="m.won ? 'text-amber' : ''">{{ m.won ? 'Gewonnen' : 'Verloren' }}</span>
              <span>
                <q-icon name="straighten" size="12px" />
                {{ metersLabel(m.distanceM) }}
              </span>
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </template>
  </q-page>
</template>

<script setup>
/** Player stats page — aggregated career numbers + recent matches. */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/services/api'

const route = useRoute()
const player = ref(null)
const loading = ref(true)
const error = ref(null)

const displayName = computed(() => player.value?.name ?? route.params.name)
const s = computed(
  () =>
    player.value?.stats ?? {
      matches: 0,
      wins: 0,
      hiderMatches: 0,
      hunterMatches: 0,
      timesCaught: 0,
      timesSurvived: 0,
      captures: 0,
      exposures: 0,
      distanceM: 0,
      avgSurvivedPct: null,
      avgCatchPct: null,
    },
)
const winRate = computed(() =>
  s.value.matches ? Math.round((s.value.wins / s.value.matches) * 100) : 0,
)
const kmLabel = computed(() => `${((s.value.distanceM ?? 0) / 1000).toFixed(1)} km`)

/** Ø percentages arrive as numbers (or null without such matches). */
function pctLabel(v) {
  return v == null ? '–' : `${Math.round(v)}%`
}

function metersLabel(m) {
  return (m ?? 0) >= 1000 ? `${((m ?? 0) / 1000).toFixed(1)} km` : `${Math.round(m ?? 0)} m`
}

function roleLabel(role) {
  return role === 'hunter' ? 'Jäger' : 'Verstecker'
}

function matchDate(iso) {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : '–'
}

async function load() {
  loading.value = true
  error.value = null
  try {
    player.value = await api.player(route.params.name)
  } catch (err) {
    error.value = err.message || 'Statistiken konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

watch(() => route.params.name, load)
onMounted(load)
</script>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
}

.stat-card {
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  text-align: center;
}

.match-list {
  max-width: 640px;
  width: 100%;
  margin: 0 auto;
}

.match-item {
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.mm-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 2px;
}
</style>
