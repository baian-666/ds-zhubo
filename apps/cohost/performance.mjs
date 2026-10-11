import {parseMotionSequence,sequenceDuration} from '../../integrations/airi/motion-sequence.ts'
export const performances = ['idle', 'listen', 'think', 'nod', 'smile', 'surprise', 'pout']

// Text is emitted immediately except a possible control prefix. Controls can follow a spoken sentence.
// Incomplete/oversized control bodies are discarded, never sent to captions, TTS or history.
export async function* performedText(chunks, onPerformance) {
  const markers=['<perform:','<act:','<act>','</act>']
  let buffer='',control=null,discard=false,actions=0
  for await(const chunk of chunks) {
    buffer+=chunk
    while(buffer) {
      if(control) {
        const end=buffer.indexOf('>')
        if(end<0){if(buffer.length>2048){buffer='';discard=true}break}
        const payload=buffer.slice(0,end);buffer=buffer.slice(end+1)
        if(!discard && payload.length<=2048 && actions<2) {
          if(control==='<perform:' && performances.includes(payload)){onPerformance(payload);actions++}
          if(control==='<act:' || control==='<act>') {
            let motion
            try {motion=parseMotionSequence(JSON.parse(payload.replace(/<\/act$/,'')))} catch {}
            if(motion){onPerformance('sequence',motion);actions++}
          }
        }
        control=null;discard=false
        continue
      }
      const start=buffer.indexOf('<')
      if(start<0){yield buffer;buffer='';break}
      if(start>0){yield buffer.slice(0,start);buffer=buffer.slice(start)}
      const marker=markers.find(value=>buffer.startsWith(value))
      if(marker){buffer=buffer.slice(marker.length);if(marker!=='</act>')control=marker;continue}
      if(markers.some(value=>value.startsWith(buffer)))break
      yield '<';buffer=buffer.slice(1)
    }
  }
  if(buffer && !control && !markers.some(value=>value.startsWith(buffer)))yield buffer
}

/** One transient performance, owned by its reply turn. Pending speech waits at most 30 seconds. */
export class Performance {
  constructor({ now = Date.now } = {}) { this.now = now; this.sequence = 0; this.current = null }
  play(name, { motion, turn = null, source = 'model', durationMs = 2600, defer = false } = {}) {
    const parsed=motion===undefined ? null : parseMotionSequence(motion)
    if(motion!==undefined && !parsed)return false
    if(!parsed && !performances.includes(name))return false
    const duration=parsed ? sequenceDuration(parsed)+250 : durationMs
    this.current = { id: ++this.sequence, name:parsed ? 'sequence' : name, turn, source,
      ...(parsed ? {motion:parsed} : {}), startedAt:defer ? null : this.now(),
      durationMs:duration, expiresAt:this.now()+(defer ? 30000 : duration) }
    return true
  }
  start(turn) {
    const current=this.current
    if(current?.turn!==turn || current.startedAt!==null || current.expiresAt<=this.now())return false
    current.startedAt=this.now();current.expiresAt=this.now()+current.durationMs
    return true
  }
  clear() { this.current = null; this.sequence++ }
  cancel(turn) { if(this.current?.turn===turn)this.clear() }
  snapshot({muted,hostSpeaking,busy,thinking=false}={}) {
    if(this.current?.expiresAt<=this.now())this.clear()
    const current=muted ? null : this.current
    if(current)return {...current,expiresAt:current.startedAt===null ? this.now()+1200 : current.expiresAt}
    return {id:this.sequence,name:muted?'idle':hostSpeaking?'listen':busy||thinking?'think':'idle',turn:null,source:'state',expiresAt:this.now()+1200}
  }
}
