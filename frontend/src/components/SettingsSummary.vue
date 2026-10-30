<template>
  <q-card flat class="settings-summary">
    <q-card-section class="row items-center q-py-sm q-gutter-x-sm">
      <q-icon name="tune" size="20px" color="primary" />
      <div class="text-subtitle1 text-weight-medium">Spieleinstellungen</div>
      <q-space />
      <div class="text-caption text-grey-6">vom Host festgelegt</div>
    </q-card-section>

    <q-card-section class="q-pt-none">
      <div class="summary-grid">
        <div v-for="def in SETTING_DEFS" :key="def.key" class="summary-item">
          <div class="text-caption text-grey-6 ellipsis">{{ def.label }}</div>
          <div class="text-body2 text-weight-medium summary-value">
            {{ formatSettingValue(settings?.[def.key] ?? def.default, def.unit) }}
          </div>
        </div>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup>
/**
 * Read-only mirror of the host's game settings — shown to everyone else in
 * the lobby so they always know what match they are about to play.
 */
import { SETTING_DEFS, formatSettingValue } from '@/services/settingsSchema'

defineProps({
  settings: { type: Object, default: () => ({}) },
})
</script>

<style scoped>
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px 14px;
}

.summary-item {
  background: var(--mm-surface, rgba(255, 255, 255, 0.045));
  border-radius: var(--mm-radius-sm, 14px);
  padding: 8px 12px;
}

.summary-value {
  font-variant-numeric: tabular-nums;
  color: var(--mm-green, #00e676);
}
</style>
