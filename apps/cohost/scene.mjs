// Live observations are separate from delivered model conversation history.
export class Scene {
  constructor({ limit = 60, maxChars = 12000, now = Date.now, snapshot, onChange = () => {}, onEntry = () => {} } = {}) {
    this.onChange=onChange
    this.onEntry=onEntry
    this.limit = limit; this.maxChars = maxChars; this.now = now; this.version = 0; this.topic = 1; this.entries = []
    if(snapshot) {
      this.topic=snapshot.topic+1;this.version=snapshot.version+1
      this.entries=structuredClone(snapshot.entries)
      for(const entry of this.entries) {
        delete entry.utterance
        if(entry.deliveryState==='partial')entry.deliveryState='interrupted'
      }
      this.trim()
    }
  }
  add(role, text, meta = {}) {
    const entry = { ...meta, topic:this.topic, role, text, at: this.now(), id: ++this.version }
    this.entries.push(entry)
    this.trim()
    this.onChange()
    this.onEntry(entry)
    return entry
  }
  host(text, utterance = null) {
    return this.entries.findLast(x => x.role === 'host' && utterance !== null && x.utterance === utterance && x.text === text)
      ?? this.add('host', text, { utterance })
  }
  snapshot(engine = 'deepseek', characterId) {
    return this.entries.filter(x => x.role !== 'assistant' || (x.engine === engine && (!characterId || x.characterId === characterId))).map(x => ({ ...x }))
  }
  delivered(text, meta) {
    const entry=this.entries.find(item=>item.deliveryId===meta.deliveryId)
    if(entry) {Object.assign(entry,meta,{text});this.trim();this.version++;this.onChange();this.onEntry(entry);return}
    this.add('assistant',text,meta)
  }
  checkpoint() {return {topic:this.topic,version:this.version,entries:this.entries.map(entry=>({...entry}))}}
  trim() {
    while (this.entries.length > this.limit || (this.entries.length > 1 && JSON.stringify(this.entries).length > this.maxChars)) this.entries.shift()
  }
  nextTopic() { this.topic++; this.version++;this.onChange() }
  clear() { this.entries = []; this.topic=1; this.version++;this.onChange() }
}
