/**
 * Game settings schema — client mirror of `backend/src/settings.js`.
 * Drives the host configuration UI (sliders/inputs) and clamping.
 */

export const SETTING_DEFS = [
  {
    key: 'gameDurationSeconds',
    label: 'Spieldauer',
    hint: 'Zeitlimit des Matches',
    min: 180,
    max: 3600,
    step: 30,
    unit: 'time',
    default: 600,
  },
  {
    key: 'hidePhaseSeconds',
    label: 'Versteckphase',
    hint: 'Vorsprung für Verstecker vor Jagdbeginn (0 = aus)',
    min: 0,
    max: 600,
    step: 5,
    unit: 'time',
    default: 60,
  },
  {
    key: 'endgameEnabled',
    label: 'Endgame',
    hint: 'Letzte Phase: Jäger werden unsichtbar, die Zone schrumpft jede Sekunde',
    unit: 'bool',
    default: true,
  },
  {
    key: 'endgameDurationSeconds',
    label: 'Endgame-Dauer',
    hint: 'Länge der Endphase — mit ihrem Ende endet das Match',
    min: 30,
    max: 1200,
    step: 30,
    unit: 'time',
    default: 300,
  },
  {
    key: 'endgameMinZoneRadius',
    label: 'Endgame-Endradius',
    hint: 'Radius, auf den die Zone im Endgame sekündlich zusteuert',
    min: 20,
    max: 1000,
    step: 10,
    unit: 'm',
    default: 100,
  },
  {
    key: 'endgameNoticeSeconds',
    label: 'Endgame-Vorlauf',
    hint: 'Mindestens so lange vorher wird die Endzone angezeigt — klassisches Schrumpfen ruht dann',
    min: 10,
    max: 600,
    step: 10,
    unit: 'time',
    default: 90,
  },
  {
    key: 'initialZoneRadius',
    label: 'Anfangs-Radius der Zone',
    hint: 'Startradius der Sicherheitszone',
    min: 50,
    max: 2000,
    step: 50,
    unit: 'm',
    default: 500,
  },
  {
    key: 'zoneShrinkInterval',
    label: 'Schrumpf-Intervall',
    hint: 'Wie oft die Zone schrumpft',
    min: 30,
    max: 600,
    step: 10,
    unit: 'time',
    default: 150,
  },
  {
    key: 'zoneShrinkPercent',
    label: 'Zonen-Schrumpfung',
    hint: 'Radius-Reduktion pro Schrumpf-Tick',
    min: 5,
    max: 50,
    step: 1,
    unit: '%',
    default: 25,
  },
  {
    key: 'zoneShiftEnabled',
    label: 'Zonen-Drift',
    hint: 'Verschiebt die Zone bei jedem Schrumpfen zufällig weiter',
    unit: 'bool',
    default: true,
  },
  {
    key: 'hiderRevealInterval',
    label: 'Aufdeckungs-Intervall',
    hint: 'Wie oft Verstecker-Positionen den Jägern gezeigt werden',
    min: 10,
    max: 300,
    step: 5,
    unit: 'time',
    default: 60,
  },
  {
    key: 'proximityDistanceMeters',
    label: 'Nähe-Distanz',
    hint: 'Abstand, ab dem ein Jäger den Verstecker-Alarm auslöst',
    min: 5,
    max: 100,
    step: 1,
    unit: 'm',
    default: 25,
  },
  {
    key: 'proximityBeepInterval',
    label: 'Piep-Intervall',
    hint: 'Wiederholrate des Alarms, solange ein Jäger in Reichweite ist',
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
    if (def.unit === 'bool') {
      out[def.key] = Boolean(input[def.key])
      continue
    }
    const raw = Number(input[def.key])
    if (!Number.isFinite(raw)) continue
    const stepped = Math.round(raw / def.step) * def.step
    out[def.key] = Math.min(def.max, Math.max(def.min, Math.round(stepped)))
  }
  return out
}

/** Human readable value, e.g. 600s → "10:00", 500 → "500 m", true → "An". */
export function formatSettingValue(value, unit) {
  if (unit === 'bool') return value ? 'An' : 'Aus'
  if (unit === 'time') {
    const m = Math.floor(value / 60)
    const s = value % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }
  if (unit === '%') return `${value} %`
  return `${value} m`
}
