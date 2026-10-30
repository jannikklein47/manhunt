/**
 * Game settings schema — client mirror of `backend/src/settings.js`.
 * Drives the host configuration UI (sliders/inputs) and clamping.
 */

export const SETTING_DEFS = [
  {
    key: 'gameDurationSeconds',
    label: 'Game duration',
    hint: 'Total match time limit',
    min: 180,
    max: 3600,
    step: 30,
    unit: 'time',
    default: 600,
  },
  {
    key: 'hidePhaseSeconds',
    label: 'Hiding phase',
    hint: 'Head start for hiders before the hunt begins (0 = off)',
    min: 0,
    max: 600,
    step: 5,
    unit: 'time',
    default: 60,
  },
  {
    key: 'initialZoneRadius',
    label: 'Initial zone radius',
    hint: 'Starting radius of the safe zone',
    min: 50,
    max: 2000,
    step: 50,
    unit: 'm',
    default: 500,
  },
  {
    key: 'zoneShrinkInterval',
    label: 'Zone shrink interval',
    hint: 'How often the zone shrinks',
    min: 30,
    max: 600,
    step: 10,
    unit: 'time',
    default: 150,
  },
  {
    key: 'zoneShrinkPercent',
    label: 'Zone shrink amount',
    hint: 'Radius reduction per shrink tick',
    min: 5,
    max: 50,
    step: 1,
    unit: '%',
    default: 25,
  },
  {
    key: 'hiderRevealInterval',
    label: 'Hider reveal interval',
    hint: 'How often hider positions are exposed to hunters',
    min: 10,
    max: 300,
    step: 5,
    unit: 'time',
    default: 60,
  },
  {
    key: 'proximityDistanceMeters',
    label: 'Proximity distance',
    hint: 'Hunter-in-range threshold for hider alerts',
    min: 5,
    max: 100,
    step: 1,
    unit: 'm',
    default: 25,
  },
  {
    key: 'proximityBeepInterval',
    label: 'Proximity beep interval',
    hint: 'Repeat rate of the audio alert while a hunter is in range',
    min: 5,
    max: 60,
    step: 1,
    unit: 'time',
    default: 30,
  },
]

export const DEFAULT_SETTINGS = Object.fromEntries(
  SETTING_DEFS.map((def) => [def.key, def.default]),
)

/** Coerce + clamp a partial settings object to the schema ranges. */
export function clampSettings(input = {}) {
  const out = {}
  for (const def of SETTING_DEFS) {
    if (input[def.key] === undefined) continue
    const raw = Number(input[def.key])
    if (!Number.isFinite(raw)) continue
    const stepped = Math.round(raw / def.step) * def.step
    out[def.key] = Math.min(def.max, Math.max(def.min, Math.round(stepped)))
  }
  return out
}

/** Human readable value, e.g. 600s → "10:00", 500 → "500 m", 25 → "25 %". */
export function formatSettingValue(value, unit) {
  if (unit === 'time') {
    const m = Math.floor(value / 60)
    const s = value % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }
  if (unit === '%') return `${value} %`
  return `${value} m`
}
