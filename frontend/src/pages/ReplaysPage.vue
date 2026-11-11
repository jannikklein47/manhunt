<template>
  <q-page class="replays-page column q-pa-md">
    <q-toolbar class="q-px-none">
      <q-btn flat round dense icon="arrow_back" @click="$router.push('/')" />
      <q-toolbar-title class="text-h6">Replays</q-toolbar-title>
      <q-btn flat round dense icon="refresh" :loading="loading" @click="load" />
    </q-toolbar>

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

    <div v-else-if="!matches.length" class="col column items-center justify-center text-grey-5">
      <q-icon name="sports_esports" size="48px" />
      <div class="q-mt-sm text-subtitle1">Noch keine aufgezeichneten Spiele</div>
      <div class="text-caption">Jedes beendete Match wird automatisch aufgezeichnet.</div>
    </div>

    <q-list v-else class="col-shrink match-list q-gutter-y-sm">
      <q-item
        v-for="m in matches"
        :key="m.id"
        clickable
        class="match-item rounded-borders"
        @click="$router.push(`/replays/${m.id}`)"
      >
        <q-item-section avatar>
          <q-icon
            :name="
              m.winner === 'hunters' ? 'radar' : m.winner === 'hiders' ? 'visibility_off' : 'block'
            "
            :color="m.winner === 'hunters' ? 'red' : m.winner === 'hiders' ? 'green' : 'grey-5'"
            size="32px"
          />
        </q-item-section>
        <q-item-section>
          <q-item-label class="text-weight-bold text-h6 mm-mono">{{ m.lobbyCode }}</q-item-label>
          <q-item-label caption>{{ formatMatchDate(m.startedAt) }}</q-item-label>
        </q-item-section>
        <q-item-section side>
          <div class="column items-end text-caption text-grey-5">
            <span>
              <q-icon name="schedule" size="12px" />
              {{ matchDurationLabel(m) }}
            </span>
            <span>
              <q-icon name="group" size="12px" />
              {{ m.playerCount ?? '?' }} Spieler · {{ m.eventCount ?? 0 }} Aktionen
            </span>
          </div>
        </q-item-section>
      </q-item>
    </q-list>
  </q-page>
</template>

<script setup>
/** Match replay list — every recorded game with code, date and result. */
import { onMounted, ref } from 'vue'
import { api } from '@/services/api'
import { formatMatchDate, formatClock } from '@/services/replay'

const matches = ref([])
const loading = ref(true)
const error = ref(null)

function matchDurationLabel(m) {
  if (!m.endedAt || !m.startedAt) return '–'
  const s = Math.round((new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime()) / 1000)
  return formatClock(s)
}

async function load() {
  loading.value = true
  error.value = null
  try {
    matches.value = await api.matches()
  } catch (err) {
    error.value = err.message || 'Replays konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
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
