// Live observations are separate from delivered model conversation history.
export class Scene {
  constructor({ limit = 60, maxChars = 12000, now = Date.now } = {}) {
    this.limit = limit; this.maxChars = maxChars; this.now = now; this.version = 0; this.entries = []
  }
  add(role, text, meta = {}) {
    const entry = { ...meta, role, text, at: this.now(), id: ++this.version }
    this.entries.push(entry)
    while (this.entries.length > this.limit || (this.entries.length > 1 && JSON.stringify(this.entries).length > this.maxChars)) this.entries.shift()
    return entry
  }
  host(text, utterance = null) {
    return this.entries.findLast(x => x.role === 'host' && utterance !== null && x.utterance === utterance && x.text === text)
      ?? this.add('host', text, { utterance })
  }
  snapshot(engine = 'deepseek') {
    return this.entries.filter(x => x.role !== 'assistant' || x.engine === engine).map(x => ({ ...x }))
  }
  clear() { this.entries = []; this.version++ }
}
