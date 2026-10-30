/**
 * Screen Wake Lock API helper.
 *
 * Requests a screen wake lock during active matches so mobile browsers do
 * not throttle the WebSocket connection / GPS while the screen is on, and
 * automatically re-acquires the lock when the page becomes visible again
 * (browsers release the lock on tab switch).
 */

let sentinel = null
let wanted = false

export function wakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

export async function requestWakeLock() {
  wanted = true
  if (!wakeLockSupported()) return false
  if (sentinel && !sentinel.released) return true
  try {
    sentinel = await navigator.wakeLock.request('screen')
    sentinel.addEventListener('release', () => {
      sentinel = null
    })
    return true
  } catch {
    // Denied or battery-saver mode — the game still works, screen may dim.
    sentinel = null
    return false
  }
}

export function releaseWakeLock() {
  wanted = false
  if (sentinel && !sentinel.released) {
    sentinel.release().catch(() => {})
  }
  sentinel = null
}

// Re-acquire the lock when the user returns to the tab/app.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted && !sentinel) {
      requestWakeLock()
    }
  })
}
