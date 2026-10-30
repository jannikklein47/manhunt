<template>
  <q-page class="home-page column items-center justify-center q-pa-lg">
    <div class="col-shrink text-center q-mb-xl">
      <div class="text-h2 text-weight-bolder brand-title">MANHUNT</div>
      <div class="text-subtitle1 text-grey-5">Real-time outdoor hide &amp; seek · GPS required</div>
    </div>

    <q-card class="col-shrink action-card" flat bordered>
      <q-card-section class="q-gutter-y-md">
        <q-input
          v-model="playerName"
          dark
          outlined
          label="Your name"
          maxlength="24"
          counter
          autocomplete="nickname"
          @keyup.enter="openJoin"
        >
          <template #prepend>
            <q-icon name="person" />
          </template>
        </q-input>

        <div class="text-caption text-grey-5">You will play as</div>
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

        <q-btn
          class="full-width"
          color="primary"
          size="lg"
          unelevated
          no-caps
          icon="add_circle"
          label="Create room"
          :disable="!playerName.trim()"
          @click="goCreate"
        />

        <q-btn
          class="full-width"
          color="secondary"
          size="lg"
          outline
          no-caps
          icon="login"
          label="Join with code"
          :disable="!playerName.trim()"
          @click="openJoin"
        />
      </q-card-section>

      <q-card-section class="text-caption text-grey-6 q-pt-none">
        Creating a room makes you the host: you pick the map area and configure the match before
        inviting friends with a 4-letter code.
      </q-card-section>
    </q-card>

    <q-dialog v-model="joinOpen" persistent>
      <q-card style="min-width: 320px" dark>
        <q-card-section>
          <div class="text-h6">Join a room</div>
        </q-card-section>
        <q-card-section class="q-gutter-y-md">
          <q-input
            v-model="joinCode"
            dark
            outlined
            label="Room code"
            maxlength="4"
            class="code-input"
            autofocus
            @keyup.enter="join"
          >
            <template #prepend>
              <q-icon name="meeting_room" />
            </template>
          </q-input>
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
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn
            unelevated
            no-caps
            color="primary"
            label="Join"
            :loading="joining"
            :disable="joinCode.trim().length < 4"
            @click="join"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useQuasar } from 'quasar'

import { unlockAudio } from '@/services/audio'
import { useGameStore } from '@/stores/game'

const router = useRouter()
const $q = useQuasar()
const store = useGameStore()

const playerName = ref(localStorage.getItem('manhunt:name') || '')
const role = ref(localStorage.getItem('manhunt:role') || 'hunter')
const joinOpen = ref(false)
const joinCode = ref('')
const joining = ref(false)

watch(playerName, (v) => localStorage.setItem('manhunt:name', v.trim()))
watch(role, (v) => localStorage.setItem('manhunt:role', v))

onMounted(() => {
  if (store.lastError) store.clearError()
})

function goCreate() {
  if (!playerName.value.trim()) return
  unlockAudio() // user gesture → future beeps are allowed
  router.push('/create')
}

function openJoin() {
  if (!playerName.value.trim()) return
  unlockAudio()
  joinCode.value = ''
  joinOpen.value = true
}

async function join() {
  const code = joinCode.value.trim().toUpperCase()
  if (!playerName.value.trim() || code.length < 4) return
  joining.value = true
  try {
    await store.joinRoom({ roomCode: code, playerName: playerName.value.trim(), role: role.value })
    joinOpen.value = false
    router.push(`/room/${code}`)
  } catch (err) {
    $q.notify({ type: 'negative', message: err.message })
  } finally {
    joining.value = false
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
.home-page {
  background: radial-gradient(ellipse at 50% 0%, rgba(0, 230, 118, 0.09), transparent 55%), #121212;
}

.brand-title {
  letter-spacing: 0.35em;
  color: #00e676;
  text-shadow: 0 0 30px rgba(0, 230, 118, 0.35);
}

.action-card {
  width: 100%;
  max-width: 420px;
}

.code-input :deep(input) {
  text-transform: uppercase;
  letter-spacing: 0.4em;
  font-weight: 700;
}
</style>
