/**
 * Web Audio API alert sounds.
 *
 * Mobile browsers block audio until a user gesture — `unlockAudio()` must be
 * called from a click handler (e.g. "Join Room") to create/resume the
 * AudioContext. The proximity alert itself is a 1000 Hz square wave beep
 * lasting 400 ms (spec §4.3).
 */

let audioContext = null

/** Call from a user-gesture handler; safe to call repeatedly. */
export function unlockAudio() {
  try {
    if (!audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return null
      audioContext = new Ctx()
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {})
    }
  } catch {
    audioContext = null
  }
  return audioContext
}

/** Fire a single beep. No-op until unlockAudio() succeeded. */
export function playBeep({
  frequency = 1000,
  durationMs = 400,
  type = 'square',
  volume = 0.2,
} = {}) {
  if (!audioContext) return false
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {})
  }
  try {
    const osc = audioContext.createOscillator()
    const gain = audioContext.createGain()
    osc.type = type
    osc.frequency.value = frequency

    const now = audioContext.currentTime
    const dur = durationMs / 1000
    // Short attack + exponential decay avoids clicks/pops on mobile speakers.
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur)

    osc.connect(gain)
    gain.connect(audioContext.destination)
    osc.start(now)
    osc.stop(now + dur + 0.05)
    return true
  } catch {
    return false
  }
}
