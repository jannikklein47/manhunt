<template>
  <q-page class="column q-pb-xl">
    <q-toolbar class="q-px-none">
      <q-btn flat round dense icon="arrow_back" @click="router.back()" />
      <q-toolbar-title>Create a room</q-toolbar-title>
    </q-toolbar>

    <div class="row q-col-gutter-lg justify-center">
      <!-- Zone picker -->
      <div class="col-12 col-md-6">
        <q-card flat bordered>
          <q-card-section class="row items-center q-py-sm q-gutter-x-sm">
            <q-icon name="my_location" color="primary" size="22px" />
            <div class="text-subtitle1 text-weight-medium">Safe zone center</div>
            <q-space />
            <q-btn
              dense
              no-caps
              unelevated
              icon="gps_fixed"
              label="Use my GPS"
              :loading="locating"
              @click="useGps"
            />
          </q-card-section>

          <q-banner v-if="!picked" class="bg-dark text-grey-4" dense>
            Tap the map or press “Use my GPS” to place the zone center ({{
              settings.initialZoneRadius
            }}
            m radius).
          </q-banner>

          <div class="map-holder">
            <GameMap
              mode="picker"
              v-model:picked="picked"
              :zone-center="picked"
              :zone-radius="settings.initialZoneRadius"
              :fit-key="fitKey"
            />
          </div>
        </q-card>
      </div>

      <!-- Settings + identity -->
      <div class="col-12 col-md-6">
        <q-card flat bordered class="q-mb-lg">
          <q-card-section class="q-gutter-y-md">
            <q-input v-model="playerName" dark outlined label="Your name" maxlength="24" counter>
              <template #prepend>
                <q-icon name="person" />
              </template>
            </q-input>

            <div>
              <div class="text-caption text-grey-5 q-mb-xs">Your role</div>
              <q-btn-toggle
                v-model="role"
                dark
                spread
                rounded
                no-caps
                toggle-color="primary"
                :options="[
                  { label: 'Hunter', value: 'hunter', icon: 'radar' },
                  { label: 'Hider', value: 'hider', icon: 'visibility_off' },
                ]"
              />
            </div>
          </q-card-section>
        </q-card>

        <SettingsPanel v-model="settings" />

        <q-btn
          class="full-width q-mt-lg"
          color="primary"
          size="lg"
          unelevated
          no-caps
          icon="sports_esports"
          label="Create room &amp; open lobby"
          :loading="creating"
          :disable="!playerName.trim() || !picked"
          @click="create"
        />
        <div v-if="!picked" class="text-caption text-grey-6 q-mt-sm text-center">
          Pick a zone center first
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useQuasar } from 'quasar'

import GameMap from '@/components/GameMap.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import { unlockAudio } from '@/services/audio'
import { currentPosition } from '@/services/geo'
import { DEFAULT_SETTINGS } from '@/services/settingsSchema'
import { useGameStore } from '@/stores/game'

const router = useRouter()
const $q = useQuasar()
const store = useGameStore()

const playerName = ref(localStorage.getItem('manhunt:name') || '')
const role = ref(localStorage.getItem('manhunt:role') || 'hunter')
const settings = ref({ ...DEFAULT_SETTINGS })
const picked = ref(null)
const fitKey = ref(0)
const locating = ref(false)
const creating = ref(false)

async function useGps() {
  locating.value = true
  try {
    const pos = await currentPosition()
    picked.value = { lat: pos.lat, lng: pos.lng }
    fitKey.value++
  } catch (err) {
    $q.notify({ type: 'negative', message: `GPS failed: ${err.message}` })
  } finally {
    locating.value = false
  }
}

async function create() {
  if (!playerName.value.trim() || !picked.value) return
  creating.value = true
  unlockAudio()
  try {
    const res = await store.createRoom({
      hostName: playerName.value.trim(),
      role: role.value,
      zoneCenter: picked.value,
      settings: settings.value,
    })
    router.push(`/room/${res.roomState.code}`)
  } catch (err) {
    $q.notify({ type: 'negative', message: err.message })
  } finally {
    creating.value = false
  }
}

let errorWatch = null
onMounted(() => {
  errorWatch = watch(
    () => store.lastError,
    (msg) => {
      if (msg) {
        $q.notify({ type: 'negative', message: msg })
        store.clearError()
      }
    },
  )
})
onBeforeUnmount(() => {
  errorWatch?.()
})
</script>

<style scoped>
.map-holder {
  height: 46vh;
  min-height: 300px;
}
</style>
