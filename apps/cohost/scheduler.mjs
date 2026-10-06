// One instance owns one live session. Platform adapters must assign stable IDs.
export class Scheduler {
  constructor({ now = Date.now, cooldownMs = 20_000, userCooldownMs = 60_000, ttlMs = 20_000 } = {}) {
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
    this.active?.controller.abort()
    this.active = null
  }

  setHostSpeaking(value) {
    this.hostSpeaking = value
    if (value) this.interrupt()
  }

  setMuted(value) {
    this.muted = value
    if (value) this.interrupt()
  }

  beginHost(text) {
    if (this.muted || this.hostSpeaking) return null
    this.interrupt()
    return this.begin({ source: 'host', text })
  }

  beginViewer() {
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
    const turn = { id: ++this.version, controller: new AbortController(), input }
    this.active = turn
    return turn
  }

  isCurrent(turn) {
    return this.active?.id === turn.id && !turn.controller.signal.aborted
  }

  finish(turn) {
    if (this.isCurrent(turn)) this.active = null
  }

  status() {
    this.prune()
    return { hostSpeaking: this.hostSpeaking, muted: this.muted, busy: Boolean(this.active), queued: this.queue.length, turn: this.version }
  }
}
