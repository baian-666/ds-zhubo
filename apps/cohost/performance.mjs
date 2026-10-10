export const performances = ['idle', 'listen', 'think', 'nod', 'smile', 'surprise', 'pout']

// Only the leading control marker is buffered. It never enters captions or history.
export async function* performedText(chunks, onPerformance) {
  let prefix = '', started = false
  for await (const chunk of chunks) {
    if (started) { yield chunk; continue }
    prefix += chunk
    if ('<perform:'.startsWith(prefix)) continue
    if (prefix.startsWith('<perform:')) {
      const end = prefix.indexOf('>')
      if (end < 0 && prefix.length < 64) continue
      if (end >= 0) {
        const name = prefix.slice(9, end)
        if (performances.includes(name)) onPerformance(name)
        prefix = prefix.slice(end + 1).trimStart()
      } else prefix = ''
    }
    started = true
    if (prefix) yield prefix
  }
  if (!started && prefix && !prefix.startsWith('<')) yield prefix
}

export class Performance {
  constructor({ now = Date.now } = {}) { this.now = now; this.sequence = 0; this.current = null }
  play(name, { turn = null, source = 'model', durationMs = 2600 } = {}) {
    if (!performances.includes(name)) return false
    this.current = { id: ++this.sequence, name, turn, source, expiresAt: this.now() + durationMs }
    return true
  }
  clear() { this.current = null; this.sequence++ }
  cancel(turn) { if (this.current?.turn === turn) this.clear() }
  snapshot({ muted, hostSpeaking, busy, thinking = false } = {}) {
    if (this.current?.expiresAt <= this.now()) this.clear()
    const current = muted ? null : this.current
    return current ?? { id:this.sequence, name:muted ? 'idle' : hostSpeaking ? 'listen' : busy || thinking ? 'think' : 'idle', turn:null, source:'state', expiresAt:this.now()+1200 }
  }
}
