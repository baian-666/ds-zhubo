/** Tracks short pauses from VAD samples without ending the ASR segment. */
export class SpeechPause {
  private silence = 0
  private sent = 0
  private paused = false
  private observedAt = 0

  /** VAD hysteresis can span real silence. Energy keeps the pause clock on the waveform. */
  audible(speech: boolean, buffer: Float32Array) {
    if (!speech || !buffer.length)
      return false
    const rms = Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length)
    return rms >= 0.003
  }

  observe(speech: boolean, samples: number, now = Date.now()): boolean | undefined {
    this.observedAt = now
    if (speech) {
      const resumed = this.paused
      this.silence = 0
      this.sent = 0
      this.paused = false
      return resumed ? false : undefined
    }
    this.silence += samples
    // VAD uses 16 kHz. A 200 ms gap opens a short, renewable playback window.
    if (this.silence >= 3200 && (!this.paused || this.silence - this.sent >= 3840)) {
      this.paused = true
      this.sent = this.silence
      return true
    }
  }

  quiet(now = Date.now()) {
    return this.paused && now - this.observedAt <= 700
  }

  reset() {
    this.silence = 0
    this.sent = 0
    this.paused = false
    this.observedAt = 0
  }
}
