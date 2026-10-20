import { describe, expect, it } from 'vitest'

import { SpeechPause } from './speech-pause'

describe('short speech pauses', () => {
  it('uses waveform silence despite VAD hangover without treating noise alone as speech', () => {
    const pause = new SpeechPause()
    expect(pause.audible(true, new Float32Array(512))).toBe(false)
    expect(pause.audible(false, new Float32Array(512).fill(0.1))).toBe(false)
    expect(pause.audible(true, new Float32Array(512).fill(0.1))).toBe(true)
  })
  it('opens at 200 ms, renews, and closes on resumed speech', () => {
    const pause = new SpeechPause()
    expect(pause.observe(true, 1600, 1000)).toBeUndefined()
    expect(pause.observe(false, 2400, 1150)).toBeUndefined()
    expect(pause.observe(false, 800, 1200)).toBe(true)
    expect(pause.quiet(1200)).toBe(true)
    expect(pause.observe(false, 3840, 1520)).toBe(true)
    expect(pause.observe(true, 160, 1530)).toBe(false)
    expect(pause.quiet(1530)).toBe(false)
  })

  it('never treats a stalled microphone or a new capture lease as silence', () => {
    const pause = new SpeechPause()
    pause.observe(false, 4800, 1000)
    expect(pause.quiet(1701)).toBe(false)
    pause.reset()
    expect(pause.quiet(1000)).toBe(false)
    expect(pause.observe(false, 1600, 1100)).toBeUndefined()
  })
})
