/** Read-only playback observations. Animation never schedules or delays audio. */
export interface PlaybackSample {
  key: string
  phase: 'waiting' | 'playing' | 'pause' | 'ended' | 'cancelled'
  elapsedMs: number
  quietMs: number
  endedMs: number
}

/** One renderer owns this clock. Audio IDs and chunk tokens reject stale callbacks. */
export class PerformanceClock {
  private key = ''
  private phase: PlaybackSample['phase'] = 'waiting'
  private elapsed = 0
  private quietSince = 0
  private endedAt = 0
  private serial = 0
  private chunk: { token: number, start: number, duration: number, time: () => number, level: (offset: number) => number } | undefined
  private now: () => number

  constructor(now: () => number = () => performance.now()) { this.now = now }

  begin(key: string) {
    this.key = key
    this.phase = 'waiting'
    this.elapsed = 0
    this.quietSince = this.now()
    this.chunk = undefined
  }

  start(key: string, duration: number, time: () => number, level: (offset: number) => number) {
    if (key !== this.key || this.phase === 'ended' || this.phase === 'cancelled')
      return 0
    const token = ++this.serial
    this.chunk = { token, duration, time, level, start: time() }
    if (this.phase === 'waiting')
      this.quietSince = this.now()
    this.phase = 'playing'
    return token
  }

  finish(token: number) {
    if (!this.chunk || this.chunk.token !== token)
      return
    this.elapsed += this.offset()
    this.chunk = undefined
    this.phase = 'pause'
  }

  end(key: string, cancelled = false) {
    if (key !== this.key || this.phase === 'ended' || this.phase === 'cancelled')
      return
    this.elapsed += this.offset()
    this.chunk = undefined
    this.phase = cancelled ? 'cancelled' : 'ended'
    this.endedAt = this.now()
  }

  sample(): PlaybackSample {
    const offset = this.offset()
    if (this.chunk) {
      // Only sustained near-silence counts. Quiet phonemes do not switch facial drawings.
      if (this.chunk.level(offset) > 0.002)
        this.quietSince = this.now()
      this.phase = this.now() - this.quietSince >= 180 ? 'pause' : 'playing'
    }
    return { key: this.key, phase: this.phase, elapsedMs: this.elapsed + offset, quietMs: this.now() - this.quietSince, endedMs: Math.max(0, this.now() - this.endedAt) }
  }

  private offset() {
    return this.chunk ? Math.max(0, Math.min(this.chunk.duration, this.chunk.time() - this.chunk.start)) : 0
  }
}

/** Each command starts once, even when its lease renews. Speech gaps retain the current beat. */
export class PerformanceRhythm {
  private identity = ''
  private offset = 0

  sample(command: { session: string, id: number, audioId?: string, startedAt?: number | null }, playback: PlaybackSample, now: number) {
    const identity = `${command.session}:${command.id}`
    const matching = command.audioId === playback.key
    if (identity !== this.identity) {
      this.identity = identity
      // A late action starts at its arrival, not at the beginning of an older spoken sentence.
      this.offset = matching && command.startedAt != null ? playback.elapsedMs : 0
    }
    if (!command.audioId)
      return { elapsedMs: Math.max(0, now - (command.startedAt ?? now)), weight: 1, poseWeight: 1, waiting: command.startedAt === null, finished: false, speech: false }
    if (!matching || playback.phase === 'waiting')
      return { elapsedMs: 0, weight: 0, poseWeight: 0, waiting: true, finished: false, speech: true }
    const release = playback.phase === 'ended' ? Math.max(0, 1 - playback.endedMs / 450) : 1
    const pause = playback.phase === 'pause' ? Math.min(1, Math.max(0, (playback.quietMs - 600) / 600)) : 0
    const stopped = playback.phase === 'cancelled'
    return { elapsedMs: Math.max(0, playback.elapsedMs - this.offset), weight: stopped ? 0 : release * (1 - pause * 0.35), poseWeight: stopped ? 0 : release * (1 - pause * 0.65), waiting: false, finished: stopped || release === 0, speech: true }
  }
}
