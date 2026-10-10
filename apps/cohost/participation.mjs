// One async planner beside the deterministic director. No serial second generation.
export class Participation {
  constructor({ director, scheduler, scene, plan, enabled = false, now = Date.now, debounceMs = 250, timeoutMs = 4500, opportunityMs = 6000 } = {}) {
    Object.assign(this,{director,scheduler,scene,plan,now,debounceMs,timeoutMs,opportunityMs})
    this.enabled = enabled; this.pending = false; this.job = null; this.timer = null
    this.observedUtterance = null; this.lastKey = null; this.closed = false; this.lastDecision = null
    director.semanticViewer = enabled
  }
  status() { return { enabled:this.enabled, configured:Boolean(this.plan), busy:Boolean(this.job || this.timer), lastDecision:this.lastDecision } }
  setEnabled(value) {
    if (value && !this.plan) { const error=new Error('本机未配置自主参与模型'); error.status=503; throw error }
    this.enabled=value; this.director.semanticViewer=value
    this.director.consumedUtterance=this.director.utterance?.id ?? null
    this.invalidate(); this.director.invalidate('participation_changed')
    this.lastKey=null; this.notify()
  }
  invalidate() {
    clearTimeout(this.timer); this.timer=null; this.pending=false
    this.job?.controller.abort()
  }
  context() {
    const {director:d,scheduler:s}=this
    const u=d.utterance
    const hostOpportunity=Boolean(u?.final && u.endedAt !== null && u.id !== d.consumedUtterance && u.id !== this.observedUtterance && !['stop','backchannel'].includes(d.intent) &&
      this.now()-u.endedAt < this.opportunityMs)
    const eligibleViewers=d.viewerWindow ? s.eligibleViewers() : []
    return { scene:this.scene.snapshot(), hostOpportunity, latestHost:u ? {...u} : null,
      proactiveCooldownMs:Math.max(0,d.participationCooldownMs-(this.now()-d.lastParticipation)),
      viewerWindow:d.viewerWindow, active:Boolean(s.active), hostSpeaking:s.hostSpeaking,
      eligibleViewers:eligibleViewers.slice(0,16).map(({id,platform,userId,text})=>({id,platform,userId,text})) }
  }
  key(snapshot) {
    return JSON.stringify([this.scene.version,this.director.revision,this.scheduler.version,
      snapshot.eligibleViewers.map(x=>[x.platform,x.id]),snapshot.hostOpportunity])
  }
  notify() {
    if (this.closed || !this.enabled || !this.plan || this.director.mode !== 'auto' || this.scheduler.muted ||
      this.scheduler.hostSpeaking || this.director.candidate || this.director.intent === 'stop') return
    const snapshot=this.context()
    if (!snapshot.hostOpportunity && !snapshot.eligibleViewers.length) return
    const key=this.key(snapshot)
    if (key===this.lastKey) return
    if (this.job) {
      if (key!==this.job.key) {this.pending=true;this.job.controller.abort()}
      return
    }
    if (this.timer) return
    this.timer=setTimeout(()=>{this.timer=null;void this.run()},this.debounceMs)
    this.timer.unref?.()
  }
  async run() {
    if (this.closed || !this.enabled || this.director.mode!=='auto' || this.scheduler.muted ||
      this.scheduler.hostSpeaking || this.director.candidate || ['stop','backchannel'].includes(this.director.intent) || this.job) return
    const snapshot=this.context(), key=this.key(snapshot)
    if ((!snapshot.hostOpportunity && !snapshot.eligibleViewers.length) || key===this.lastKey) return
    const job={key,controller:new AbortController(),revision:this.director.revision,version:this.scene.version,started:this.now()}
    this.job=job;this.lastKey=key;this.pending=false
    let timer
    try {
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{job.timedOut=true;job.controller.abort();reject(new Error('timeout'))},this.timeoutMs)})
      const result=await Promise.race([this.plan(snapshot,{signal:job.controller.signal}),timeout])
      if (this.closed || job.controller.signal.aborted || !this.enabled || this.director.mode!=='auto' ||
        this.scheduler.muted || this.scheduler.hostSpeaking || this.scene.version!==job.version ||
        this.director.revision!==job.revision || this.director.candidate) return
      const elapsed=Math.max(0,this.now()-job.started)
      this.apply(result,snapshot,elapsed)
      this.lastKey=this.key(this.context())
    } catch {
      if (!this.closed && (!job.controller.signal.aborted || job.timedOut) &&
        this.director.revision===job.revision && this.scene.version===job.version) {
        this.director.record('hold',job.timedOut?'participation_timeout':'participation_error',
          {explanation:'这次自主判断没有成功，我先等待新的现场消息。'})
      }
    } finally {
      clearTimeout(timer)
      if(this.job===job)this.job=null
      if(this.pending){this.pending=false;this.notify()}
    }
  }
  apply(result,snapshot,decisionMs) {
    const d=this.director,s=this.scheduler,u=d.utterance
    if (!result || !['wait','reply_host','reply_viewer','stop'].includes(result.action) ||
      typeof result.reason!=='string' || !result.reason.trim() || result.reason.length>180 ||
      typeof result.text!=='string' || result.text.length>800) throw new Error('Invalid action')
    if (snapshot.hostOpportunity && u?.id === snapshot.latestHost?.id) this.observedUtterance=u.id
    const details={explanation:result.reason,decisionMs}
    this.lastDecision={action:result.action,reason:result.reason,decisionMs,at:this.now()}
    if(result.action==='wait') {d.record('hold','participation_wait',details);return}
    if(result.action==='stop') {
      if(!snapshot.hostOpportunity || !s.active || !u || this.now()-u.endedAt>=this.opportunityMs)return
      s.interrupt();d.consumedUtterance=u.id;d.intent='stop';d.candidate=null
      d.record('stop','participation_stop',details);return
    }
    if(!result.text.trim() || s.active)return
    if(result.action==='reply_host') {
      if(!snapshot.hostOpportunity || !u?.final || u.endedAt===null || u.id===d.consumedUtterance ||
        this.now()-u.endedAt>=this.opportunityMs)return
      // Direct questions are not throttled by the proactive budget; the model receives this state.
      if(result.hostIntent !== 'invited' && this.now()-d.lastParticipation<d.participationCooldownMs) {
        d.record('hold','participation_cooldown',{explanation:'我刚补充过一次，这次先让主播继续。'});return
      }
      d.candidate={id:++d.nextDecision,revision:d.revision,text:u.text,intent:result.hostIntent === 'invited' ? 'handover' : 'opportunity',
        expiresAt:this.now()+1500,preparedReply:result.text,decisionMs}
    } else {
      if(!d.viewerWindow)return
      const item=s.eligibleViewers().find(x=>x.id===result.targetId && x.platform===result.platform)
      if(!item || !snapshot.eligibleViewers.some(x=>x.id===item.id && x.platform===item.platform))return
      d.candidate={id:++d.nextDecision,revision:d.revision,source:'viewer',messageId:item.id,platform:item.platform,
        text:item.text,intent:'viewer',expiresAt:Math.min(this.now()+1500,item.receivedAt+s.ttlMs),
        preparedReply:result.text,decisionMs,semanticSelection:true}
    }
    d.record('reply','participation_reply',details)
  }
  close() {this.closed=true;this.invalidate()}
}
