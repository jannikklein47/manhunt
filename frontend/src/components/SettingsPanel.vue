<template>
  <q-card flat class="settings-panel">
    <q-card-section class="row items-center q-py-sm q-gutter-x-sm">
      <q-icon name="tune" size="22px" color="primary" />
      <div class="text-subtitle1 text-weight-medium">Spieleinstellungen</div>
      <q-space />
      <q-btn
        flat
        dense
        no-caps
        icon="restart_alt"
        label="Standard"
        :disable="disabled"
        @click="resetToDefaults"
      />
    </q-card-section>

    <q-card-section class="q-pt-none">
      <div v-for="def in SETTING_DEFS" :key="def.key" class="q-mb-md">
        <!-- Boolean switches render as a toggle instead of input + slider. -->
        <div v-if="def.unit === 'bool'" class="row items-center no-wrap q-gutter-x-sm">
          <div class="col">
            <div class="text-body2 text-weight-medium">{{ def.label }}</div>
            <div class="text-caption text-grey-6">{{ def.hint }}</div>
          </div>
          <q-toggle
            :model-value="modelValue[def.key]"
            dense
            dark
            :disable="disabled"
            @update:model-value="setSetting(def.key, $event)"
          />
        </div>
        <template v-else>
          <div class="row items-center no-wrap q-mb-xs q-gutter-x-sm">
            <div class="col">
              <div class="text-body2 text-weight-medium">{{ def.label }}</div>
              <div class="text-caption text-grey-6">{{ def.hint }}</div>
            </div>
            <q-input
              :model-value="modelValue[def.key]"
              type="number"
              dense
              filled
              dark
              :disable="disabled"
              :min="def.min"
              :max="def.max"
              :step="def.step"
              class="setting-input"
              @update:model-value="setSetting(def.key, $event)"
            />
            <div class="text-caption text-grey-5 setting-unit">{{ unitLabel(def.unit) }}</div>
          </div>
          <q-slider
            :model-value="modelValue[def.key]"
            :min="def.min"
            :max="def.max"
            :step="def.step"
            :disable="disabled"
            label
            :label-value="formatSettingValue(modelValue[def.key], def.unit)"
            color="primary"
            @update:model-value="setSetting(def.key, $event)"
          />
        </template>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup>
import {
  SETTING_DEFS,
  DEFAULT_SETTINGS,
  clampSettings,
  formatSettingValue,
} from '@/services/settingsSchema'

const props = defineProps({
  modelValue: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

function setSetting(key, rawValue) {
  const clamped = clampSettings({ [key]: rawValue })
  if (clamped[key] === undefined) return
  emit('update:modelValue', { ...props.modelValue, [key]: clamped[key] })
}

function resetToDefaults() {
  emit('update:modelValue', { ...DEFAULT_SETTINGS })
}

function unitLabel(unit) {
  if (unit === 'time') return 's'
  return unit
}
</script>

<style scoped>
.setting-input {
  width: 84px;
}
.setting-unit {
  width: 26px;
}
</style>
