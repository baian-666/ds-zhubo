import { shallowRef } from 'vue'

import { PerformanceClock, PerformanceRhythm } from './performance-clock'

/** A renderer identity survives route changes. Other windows receive a different identity. */
export const cohostControlId = crypto.randomUUID()
export const cohostAudioBus = shallowRef<GainNode>()
export const cohostPlaying = shallowRef(false)
export const cohostCaption = shallowRef('')
export const cohostAccessToken = shallowRef('')
export const cohostNeedsToken = shallowRef(false)
export const cohostPerformanceClock = new PerformanceClock()
export const cohostPerformanceRhythm = new PerformanceRhythm()

/** Playback reports observations without depending on the animation consumer. */
export function observePerformance(observe: (clock: PerformanceClock) => void) {
  try {
    observe(cohostPerformanceClock)
  }
  catch {
    // Presentation failures cannot reject playback or turn receipts.
  }
}

/** Explicit application mode replaces development-port detection. */
export function isCohostMode() {
  if (new URLSearchParams(location.search).has('cohost'))
    localStorage.setItem('cohost/enabled', 'true')
  return localStorage.getItem('cohost/enabled') === 'true'
}
