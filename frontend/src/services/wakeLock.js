/**
 * Screen Wake Lock API helper.
 *
 * Requests a screen wake lock for as long as the room session lasts so mobile
 * browsers do not let the screen sleep (and do not throttle the WebSocket
 * connection / GPS), and automatically re-acquires the lock whenever the
 * browser revokes it — page hidden, battery saver, system pressure — see the
 * listeners at the bottom.
 */

import { ref } from 'vue'

let sentinel = null
let wanted = false
let retryTimer = null

/** Reactive: is a wake lock currently held? (drives the UI hint) */
export const wakeLockActive = ref(false)

export function wakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

export async function requestWakeLock() {
  wanted = true
  if (!wakeLockSupported()) return false
  if (sentinel && !sentinel.released) return true
  try {
    sentinel = await navigator.wakeLock.request('screen')
    wakeLockActive.value = true
    sentinel.addEventListener('release', () => {
      sentinel = null
      wakeLockActive.value = false
      // Browsers revoke the lock on their own (page hidden, battery saver).
      // Take it back right away if we are still on screen and still want it.
      if (wanted && document.visibilityState === 'visible') requestWakeLock()
    })
    clearRetry()
    return true
  } catch {
    // Denied (e.g. battery-saver mode) — retry shortly instead of giving up
    // for the rest of the session; conditions may change mid-match.
    sentinel = null
    wakeLockActive.value = false
    scheduleRetry()
    return false
  }
}

/** Try again a few seconds later — the lock is wanted but not held. */
function scheduleRetry() {
  if (!wanted || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (wanted && document.visibilityState === 'visible' && (!sentinel || sentinel.released)) {
      requestWakeLock()
    }
  }, 5000)
}

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

export function releaseWakeLock() {
  wanted = false
  clearRetry()
  if (sentinel && !sentinel.released) {
    sentinel.release().catch(() => {})
  }
  sentinel = null
  wakeLockActive.value = false
}

// Re-acquire the lock when the user returns to the tab/app (browsers release
// it the moment the page is hidden).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted) {
      if (!sentinel || sentinel.released) requestWakeLock()
    }
  })
}
