<template>
  <q-page class="leaderboard-page column q-pa-md">
    <q-toolbar class="q-px-none">
      <q-btn flat round dense icon="arrow_back" @click="$router.push('/')" />
      <q-toolbar-title class="text-h6">Bestenliste</q-toolbar-title>
      <q-btn flat round dense icon="refresh" :loading="loading" @click="load" />
    </q-toolbar>

    <!-- Jump straight to your own stats — pre-filled from the lobby name. -->
    <div class="row items-center q-gutter-sm q-mb-sm own-row">
      <q-input
        v-model="lookup"
        dense
        outlined
        clearable
        dark
        class="col-grow"
        placeholder="Spielername …"
        @keyup.enter="openPlayer"
      />
      <q-btn
        unelevated
        no-caps
        color="primary"
        icon="person_search"
        label="Meine Stats"
        :disable="!nameTrim"
        @click="openPlayer"
      />
    </div>

    <div v-if="error" class="text-negative q-my-lg text-center">
      <q-icon name="cloud_off" size="32px" />
      <div class="q-mt-sm">{{ error }}</div>
      <q-btn
        class="q-mt-md"
        outline
        no-caps
        color="secondary"
        label="Erneut versuchen"
        @click="load"
      />
    </div>

    <div v-else-if="loading" class="col column items-center justify-center">
      <q-spinner-dots size="48px" color="primary" />
    </div>

    <div v-else-if="!rows.length" class="col column items-center justify-center text-grey-5">
      <q-icon name="emoji_events" size="48px" />
      <div class="q-mt-sm text-subtitle1">Noch keine Statistiken</div>
      <div class="text-caption">Spiele ein Match — jede Teilnahme zählt.</div>
    </div>

    <div v-else class="lb-list col-shrink">
      <div
        v-for="(p, i) in rows"
        :key="p.key"
        class="lb-row rounded-borders"
        @click="$router.push(`/players/${encodeURIComponent(p.name)}`)"
      >
        <div class="rank mm-mono" :class="rankClass(i)">{{ i + 1 }}</div>
        <div class="col">
          <div class="text-weight-bold text-subtitle1">{{ p.name }}</div>
          <div class="text-caption text-grey-5">
            {{ p.matches }} Spiele · {{ p.hiderMatches }}× Verstecker · {{ p.hunterMatches }}× Jäger
          </div>
        </div>
        <div class="column items-end text-caption text-grey-5">
          <span class="text-subtitle2 text-weight-bold" :class="p.wins > 0 ? 'text-amber' : ''">
            {{ p.wins }} {{ p.wins === 1 ? 'Sieg' : 'Siege' }}
          </span>
          <span>
            <q-icon name="straighten" size="12px" />
            {{ kmLabel(p.distanceM) }}
          </span>
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup>
/** Leaderboard — per-player stats aggregated over every recorded match. */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/services/api'

const router = useRouter()
const rows = ref([])
const loading = ref(true)
const error = ref(null)
// Pre-fill the lookup with the lobby name — „Meine Stats" is one tap away.
const lookup = ref(localStorage.getItem('manhunt:name') || '')

const nameTrim = computed(() => (lookup.value ?? '').trim())

function rankClass(i) {
  if (i === 0) return 'rank-gold'
  if (i === 1) return 'rank-silver'
  if (i === 2) return 'rank-bronze'
  return ''
}

function kmLabel(meters) {
  const km = (meters ?? 0) / 1000
  return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km`
}

function openPlayer() {
  if (!nameTrim.value) return
  router.push(`/players/${encodeURIComponent(nameTrim.value)}`)
}

async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = await api.leaderboard()
  } catch (err) {
    error.value = err.message || 'Bestenliste konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.own-row {
  max-width: 640px;
  width: 100%;
  margin: 0 auto;
}

.lb-list {
  max-width: 640px;
  width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lb-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
}

.rank {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.15);
  font-weight: 700;
}

.rank-gold {
  color: #ffd54f;
  border-color: #ffd54f;
}

.rank-silver {
  color: #e0e0e0;
  border-color: #e0e0e0;
}

.rank-bronze {
  color: #ff8a65;
  border-color: #ff8a65;
}

.mm-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
