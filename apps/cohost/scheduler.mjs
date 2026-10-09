// One instance owns one live session. Platform adapters must assign stable IDs.
export class Scheduler {
  constructor({ now = Date.now, cooldownMs = 20_000, userCooldownMs = 60_000, ttlMs = 20_000, playbackTimeoutMs = 15_000 } = {}) {
    this.now = now
    this.cooldownMs = cooldownMs
    this.userCooldownMs = userCooldownMs
    this.ttlMs = ttlMs
    this.queue = []
    this.seen = new Map()
    this.users = new Map()
    this.lastViewerReply = -Infinity
    this.active = null
    this.hostSpeaking = false
    this.muted = false
    this.version = 0
    this.playbackTimeoutMs = playbackTimeoutMs
    this.onDelivered = () => {}
  }

  prune() {
    const now = this.now()
    this.queue = this.queue.filter(item => now - item.receivedAt < this.ttlMs)
    for (const [key, until] of this.seen) if (now >= until) this.seen.delete(key)
    for (const [key, until] of this.users) if (now >= until) this.users.delete(key)
  }

  enqueue(message) {
    this.prune()
    const key = `${message.platform}:${message.id}`
    if (this.seen.has(key)) return false
    this.seen.set(key, this.now() + 120_000)
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value)
    this.queue.push({ ...message, receivedAt: this.now() })
    if (this.queue.length > 128) this.queue.shift()
    return true
  }

  interrupt() {
    this.version += 1
    this.commitPlayed(this.active)
    this.active?.controller.abort()
    this.active = null
  }

  // Raw VAD is an observation, not an instruction to cancel.
  observeHostSpeaking(value) { this.hostSpeaking = value }

  setHostSpeaking(value) {
    this.hostSpeaking = value
    if (value) this.interrupt()
  }

  setMuted(value) {
    this.muted = value
    if (value) this.interrupt()
  }

  beginHost(text) {
    this.expirePlayback()
    if (this.muted || this.hostSpeaking) return null
    this.interrupt()
    return this.begin({ source: 'host', text })
  }

  beginViewer() {
    this.expirePlayback()
    this.prune()
    if (this.muted || this.hostSpeaking || this.active || this.now() - this.lastViewerReply < this.cooldownMs) return null
    // Only explicitly addressed or operator-selected messages qualify in this prototype.
    const candidates = this.queue.filter(item => (item.mentioned || item.selected) && !this.users.has(`${item.platform}:${item.userId}`))
    candidates.sort((a, b) => Number(b.selected) - Number(a.selected) || a.receivedAt - b.receivedAt)
    const item = candidates[0]
    if (!item) return null
    this.queue = this.queue.filter(candidate => candidate !== item)
    this.lastViewerReply = this.now()
    this.users.set(`${item.platform}:${item.userId}`, this.now() + this.userCooldownMs)
    return this.begin({ source: 'viewer', ...item })
  }

  begin(input) {
    const turn = { id: ++this.version, controller: new AbortController(), input,
      delivery: 'text', answer: '', playedChars: 0, committed: false,
      generationDone: false, playback: 'waiting', playbackDeadline: Infinity }
    turn.audioId = `${turn.id}:0`
    this.active = turn
    return turn
  }

  isCurrent(turn) {
    return this.active?.id === turn.id && !turn.controller.signal.aborted
  }

  finish(turn) {
    if (!this.isCurrent(turn)) return
    turn.generationDone = true
    if (turn.delivery === 'audio') {
      turn.playbackDeadline = this.now() + this.playbackTimeoutMs
    } else {
      turn.playedChars = turn.answer.length
      this.commitPlayed(turn)
      this.active = null
    }
  }

  commitPlayed(turn) {
    if (!turn || turn.committed || !turn.playedChars) return
    turn.committed = true
    this.onDelivered(turn.input, turn.answer.slice(0, turn.playedChars))
  }

  expirePlayback() {
    if (this.active?.delivery === 'audio' && this.now() >= this.active.playbackDeadline) this.interrupt()
  }

  // One logical audio stream per turn; offsets are acknowledged UTF-16 text prefixes.
  playbackEvent({ turn: id, audioId, event, playedChars }) {
    if (!['started', 'progress', 'ended', 'stopped', 'error'].includes(event)) return false
    this.expirePlayback()
    const turn = this.active
    if (!turn || turn.id !== id || turn.audioId !== audioId || turn.delivery !== 'audio') return false
    if (event === 'started') {
      if (this.hostSpeaking || this.muted || turn.playback !== 'waiting' || !turn.answer) return false
      turn.playback = 'playing'
    } else {
      if (turn.playback !== 'playing' && !['stopped', 'error'].includes(event)) return false
      if (!Number.isInteger(playedChars) || playedChars < turn.playedChars || playedChars > turn.answer.length) return false
      const before = turn.answer.charCodeAt(playedChars - 1)
      const after = turn.answer.charCodeAt(playedChars)
      if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) return false
      if (turn.playback !== 'playing' && playedChars !== 0) return false
      if (event === 'ended' && (!turn.generationDone || playedChars !== turn.answer.length)) return false
      turn.playedChars = playedChars
      if (['ended', 'stopped', 'error'].includes(event)) {
        this.interrupt()
        return true
      }
    }
    turn.playbackDeadline = this.now() + this.playbackTimeoutMs
    return true
  }

  status() {
    this.expirePlayback()
    this.prune()
    return { hostSpeaking: this.hostSpeaking, muted: this.muted, busy: Boolean(this.active), queued: this.queue.length, turn: this.version,
      generating: Boolean(this.active && !this.active.generationDone),
      playback: this.active?.delivery === 'audio' ? this.active.playback : 'idle',
      audioId: this.active?.delivery === 'audio' ? this.active.audioId : null }
  }
}
