import { randomUUID } from 'node:crypto'

// Display history is bounded and separate from the model's delivered-text history.
export class RoomJournal {
  constructor({ limit = 300, now = Date.now, snapshot } = {}) {
    this.limit = limit; this.now = now; this.session = randomUUID()
    this.version = 0; this.nextId = 0; this.entries = []
    // Operator-saved display snapshots never restore speech, decisions or microphone ownership.
    if (snapshot) {
      if (!Array.isArray(snapshot.entries)) throw new Error('Invalid room snapshot')
      const entries=structuredClone(snapshot.entries.slice(-limit))
      if(entries.some(entry=>!Number.isSafeInteger(entry.id) || entry.id<1 || !['host','viewer','assistant','director'].includes(entry.role) || typeof entry.text!=='string'))throw new Error('Invalid room snapshot')
      for(const entry of entries) {
        if(entry.role==='assistant' && !['completed','failed','cancelled'].includes(entry.status)) entry.status='cancelled'
        // Old utterance/turn numbers belong to the previous runtime.
        delete entry.utterance;delete entry.turn
        entry.restored=true;entry.revision=++this.version
      }
      this.entries=entries;this.nextId=Math.max(0,...entries.map(entry=>entry.id))
    }
  }
  add(role, text, fields = {}) {
    const entry = { ...fields, id: ++this.nextId, role, text, at: this.now(), revision: ++this.version }
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.shift()
    return entry
  }
  update(entry, fields) {
    if (!this.entries.includes(entry)) return null
    Object.assign(entry, fields, { revision: ++this.version })
    return entry
  }
  host(text, utterance = null) {
    const existing = utterance === null ? null : this.entries.findLast(x => x.role === 'host' && x.utterance === utterance && x.text === text)
    return existing ?? this.add('host', text, { utterance })
  }
  clear() { this.entries = []; this.session = randomUUID(); this.version = 0; this.nextId = 0 }
  status() { return { session: this.session, version: this.version, entries: this.entries.map(x => ({ ...x })) } }
}
