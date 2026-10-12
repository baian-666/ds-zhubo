export function parseThought(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) ||
    Object.keys(value).some(key=>!['text','wake'].includes(key)) ||
    typeof value.text!=='string' || !value.text.trim() || value.text.length>120 ||
    !['next_host_turn','after_reply'].includes(value.wake)) return null
  return {text:value.text.trim(),wake:value.wake}
}

// One ephemeral intention, never an observed fact or an already-spoken answer.
export class PendingThought {
  constructor({now=Date.now,ttlMs=45000,quietMs=1200}={}) {
    Object.assign(this,{now,ttlMs,quietMs});this.nextId=0;this.value=null
  }
  set(thought,{topic,utterance,active,activeTurn}) {
    const parsed=parseThought(thought)
    if(!parsed || (parsed.wake==='after_reply' && (!active || !Number.isSafeInteger(activeTurn))))return false
    this.value={...parsed,id:++this.nextId,topic,utterance,waitingTurn:activeTurn??null,createdAt:this.now(),expiresAt:this.now()+this.ttlMs,reviewed:false}
    return true
  }
  clear() {this.value=null}
  snapshot(topic) {
    if(this.value && (this.value.topic!==topic || this.now()>=this.value.expiresAt))this.clear()
    return this.value?{...this.value}:null
  }
  ready({topic,latestHost,active,hostSpeaking,proactiveCooldownMs,completedTurn,completedAt}) {
    const thought=this.snapshot(topic)
    return Boolean(thought && !thought.reviewed && thought.wake==='after_reply' && !active && !hostSpeaking &&
      proactiveCooldownMs===0 && completedTurn===thought.waitingTurn && this.now()-completedAt>=this.quietMs && latestHost?.final && latestHost.id===thought.utterance &&
      latestHost.endedAt!==null && this.now()-latestHost.endedAt>=this.quietMs)
  }
  take(id,topic) {
    if(this.snapshot(topic)?.id!==id)return false
    this.clear();return true
  }
}
