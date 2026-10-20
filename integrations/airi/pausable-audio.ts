/**
 * Pause one audio buffer without suspending the microphone's AudioContext.
 * Resume from the rendered offset. Cancellation discards the remaining samples.
 */
export class PausableAudio {
  readonly done: Promise<void>
  private resolve!: () => void
  private reject!: (error: unknown) => void
  private source: AudioBufferSourceNode | undefined
  private offset = 0
  private startedAt = 0
  private closed = false
  private paused = false
  private readonly abort = () => this.finish()

  constructor(private readonly context: AudioContext, private readonly buffer: AudioBuffer, private readonly destination: AudioNode, private readonly signal: AbortSignal) {
    this.done = new Promise<void>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted)
      this.finish()
  }

  get elapsedMs() {
    return Math.min(this.buffer.duration, this.offset + (this.source ? this.context.currentTime - this.startedAt : 0)) * 1000
  }

  setPaused(paused: boolean) {
    if (this.closed)
      return
    this.paused = paused
    if (paused) {
      this.offset = this.elapsedMs / 1000
      this.detach()
    }
    else if (!this.source) {
      if (this.offset >= this.buffer.duration) {
        this.finish()
        return
      }
      try {
        const source = this.context.createBufferSource()
        source.buffer = this.buffer
        source.connect(this.destination)
        source.onended = () => this.finish()
        this.source = source
        this.startedAt = this.context.currentTime
        source.start(0, this.offset)
      }
      catch (error) { this.finish(error) }
    }
  }

  get isPaused() { return this.paused }

  private detach() {
    if (!this.source)
      return
    this.source.onended = null
    this.source.stop()
    this.source.disconnect()
    this.source = undefined
  }

  private finish(error?: unknown) {
    if (this.closed)
      return
    this.offset = this.elapsedMs / 1000
    this.closed = true
    this.detach()
    this.signal.removeEventListener('abort', this.abort)
    if (error)
      this.reject(error)
    else
      this.resolve()
  }
}
