/**
 * Game settings schema — single source of truth on the server.
 * The frontend mirrors these limits in `src/services/settingsSchema.js`.
 */

export const SETTING_LIMITS = {
  gameDurationSeconds: { min: 180, max: 3600, step: 30 },
  hidePhaseSeconds: { min: 0, max: 600, step: 5 },
  initialZoneRadius: { min: 50, max: 2000, step: 50 },
  zoneShrinkInterval: { min: 30, max: 600, step: 10 },
  zoneShrinkPercent: { min: 5, max: 50, step: 1 },
  hiderRevealInterval: { min: 10, max: 300, step: 5 },
  proximityDistanceMeters: { min: 5, max: 100, step: 1 },
  proximityBeepInterval: { min: 5, max: 60, step: 1 },
}

export const DEFAULT_SETTINGS = {
  gameDurationSeconds: 600, // 10 minutes
  hidePhaseSeconds: 60, // head start for hiders before the timer starts
  initialZoneRadius: 500, // meters
  zoneShrinkInterval: 150, // seconds between shrink ticks
  zoneShrinkPercent: 25, // % radius removed per shrink tick
  hiderRevealInterval: 60, // seconds between hider position snapshots
  proximityDistanceMeters: 25, // hunter-in-range threshold
  proximityBeepInterval: 30, // seconds between proximity beeps
}

const KEYS = Object.keys(DEFAULT_SETTINGS)

/**
 * Coerce, round to the nearest step and clamp any partial settings object
 * to the configured ranges. Missing keys fall back to their defaults.
 */
export function sanitizeSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS }
  if (!input || typeof input !== 'object') return out

  for (const key of KEYS) {
    if (input[key] === undefined || input[key] === null) continue
    const raw = Number(input[key])
    if (!Number.isFinite(raw)) continue

    const { min, max, step } = SETTING_LIMITS[key]
    const stepped = Math.round(raw / step) * step
    out[key] = Math.min(max, Math.max(min, Math.round(stepped)))
  }
  return out
}

/** Merge a partial settings patch into a full sanitized settings object. */
export function mergeSettings(current, patch = {}) {
  return sanitizeSettings({ ...current, ...patch })
}
