/**
 * Geolocation API wrapper (spec §4.2):
 * - `navigator.geolocation.watchPosition` with `{ enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }`
 *
 * The service hands every fix to the caller unfiltered — accuracy policy
 * lives in the game store:
 *   - `GPS_QUALITY_MAX` (25 m): fixes good enough for game decisions
 *     (proximity alerts, out-of-zone exposure)
 *   - `GPS_REPORT_MAX` (100 m): fixes still worth reporting for map display
 */

export const GPS_QUALITY_MAX = 25
export const GPS_REPORT_MAX = 100

const WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 5000,
}

/**
 * Start watching the device position.
 * Returns a stop() function.
 */
export function watchPosition({ onFix, onError } = {}) {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    onError?.(new Error('Geolocation is not supported by this browser'))
    return () => {}
  }

  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords
      onFix?.({ lat: latitude, lng: longitude, accuracy, timestamp: pos.timestamp })
    },
    (err) => onError?.(err),
    WATCH_OPTIONS,
  )

  return () => navigator.geolocation.clearWatch(watchId)
}

/** One-shot position (used to center the zone picker on the host's GPS). */
export function currentPosition(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new Error('Geolocation is not supported by this browser'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }),
      (err) => reject(new Error(err.message || 'Could not get GPS position')),
      { ...WATCH_OPTIONS, timeout: timeoutMs },
    )
  })
}
