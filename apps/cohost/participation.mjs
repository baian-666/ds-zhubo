import { normalizePerformance, ParticipationError } from './participation-model.mjs'
import { PendingThought } from './pending-thought.mjs'
const errorMessages={
  network:'这次没有连上模型服务，我先听着；下一句再试。',
  timeout:'这次模型回应超时，我先听着；下一句再试。',
  credentials:'模型服务拒绝了当前密钥，请检查本机配置。',
  rate_limit:'模型服务暂时限流，我先听着；下一句再试。',
  provider:'模型服务暂时出错，我先听着；下一句再试。',
  truncated:'这次决定输出被截断，没拿到完整结果；下一句再试。',
  tool:'这次没有收到有效的行动决定；下一句再试。',
  json:'这次决定的格式无法解析；下一句再试。',
  arguments:'这次决定的字段不合规，未执行；下一句再试。',
  unknown:'这次调用或结果处理出错，我先听着；下一句再试。',
}
// One async planner beside the deterministic director. No serial second generation.
export class Participation {
  constructor({ director, scheduler, scene, plan, history = () => [], onReaction = () => {}, enabled = false, now = Date.now, debounceMs = 250, timeoutMs = 4500, opportunityMs = 6000, thoughtOptions = {} } = {}) {
    Object.assign(this,{director,scheduler,scene,plan,history,onReaction,now,debounceMs,timeoutMs,opportunityMs})
    this.enabled = enabled; this.pending = false; this.job = null; this.timer = null
    this.observedUtterance = null; this.lastKey = null; this.closed = false; this.lastDecision = null
    this.thought=new PendingThought({...thoughtOptions,now})
    director.followUp={validate:id=>this.thought.snapshot(scene.topic)?.id===id,
      consume:id=>this.thought.take(id,scene.topic)}
    director.semanticViewer = enabled
  }
  status() {
    this.discardIfPaused()
    return { enabled:this.enabled, configured:Boolean(this.plan), busy:Boolean(this.job || this.timer), lastDecision:this.lastDecision, pendingThought:this.thought.snapshot(this.scene.topic) }
  }
  discardIfPaused() {
    if(this.closed || !this.enabled || this.director.mode!=='auto' || this.scheduler.muted || this.director.intent==='stop')this.thought.clear()
  }
  setEnabled(value) {
    if (value && !this.plan) { const error=new Error('本机未配置自主参与模型'); error.status=503; throw error }
    this.enabled=value; this.director.semanticViewer=value
    this.thought.clear()
    this.director.consumedUtterance=this.director.utterance?.id ?? null
    this.invalidate(); this.director.invalidate('participation_changed')
    this.lastKey=null; this.notify()
  }
  invalidate({clearThought=false}={}) {
    clearTimeout(this.timer); this.timer=null; this.pending=false
    this.job?.controller.abort()
    if(clearThought)this.thought.clear()
  }
  context() {
    this.discardIfPaused()
    const {director:d,scheduler:s}=this
    const u=d.utterance
    const hostOpportunity=Boolean(u?.final && u.endedAt !== null && u.id !== d.consumedUtterance && u.id !== this.observedUtterance && !['stop','backchannel'].includes(d.intent) &&
      this.now()-u.endedAt < this.opportunityMs)
    const eligibleViewers=d.viewerWindow ? s.eligibleViewers() : []
    const snapshot={ scene:this.scene.snapshot(), currentTopic:this.scene.topic, history:this.history().map(x=>({...x})), hostOpportunity, latestHost:u ? {...u} : null,
      proactiveCooldownMs:Math.max(0,d.participationCooldownMs-(this.now()-d.lastParticipation)),
      viewerWindow:d.viewerWindow, active:Boolean(s.active), activeTurn:s.active?.id??null, completedTurn:s.lastCompletedTurn,completedAt:Number.isFinite(s.lastCompletedAt)?s.lastCompletedAt:null,hostSpeaking:s.hostSpeaking,
      eligibleViewers:eligibleViewers.slice(0,16).map(({id,platform,userId,text})=>({id,platform,userId,text})) }
    snapshot.pendingThought=this.thought.snapshot(this.scene.topic)
    snapshot.pendingOpportunity=this.thought.ready({topic:this.scene.topic,...snapshot})
    return snapshot
  }
  key(snapshot) {
    return JSON.stringify([this.director.revision,this.scheduler.version,
      snapshot.hostOpportunity ? [] : snapshot.eligibleViewers.map(x=>[x.platform,x.id]),snapshot.hostOpportunity,snapshot.pendingOpportunity?snapshot.pendingThought.id:null])
  }
  notify() {
    this.discardIfPaused()
    if (this.closed || !this.enabled || !this.plan || this.director.mode !== 'auto' || this.scheduler.muted ||
      this.scheduler.hostSpeaking || this.director.candidate || this.director.intent === 'stop') return
    const snapshot=this.context()
    if (!snapshot.hostOpportunity && !snapshot.eligibleViewers.length && !snapshot.pendingOpportunity) return
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
    this.discardIfPaused()
    if (this.closed || !this.enabled || this.director.mode!=='auto' || this.scheduler.muted ||
      this.scheduler.hostSpeaking || this.director.candidate || this.director.intent==='stop' || this.job) return
    const snapshot=this.context(), key=this.key(snapshot)
    if ((!snapshot.hostOpportunity && !snapshot.eligibleViewers.length && !snapshot.pendingOpportunity) || key===this.lastKey) return
    // At most one quiet review, even if the provider fails or the snapshot is interrupted.
    const job={key,controller:new AbortController(),revision:this.director.revision,started:this.now(),thoughtId:snapshot.pendingOpportunity?snapshot.pendingThought.id:null}
    this.job=job;this.lastKey=key;this.pending=false
    let timer
    try {
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{job.timedOut=true;job.controller.abort();reject(new Error('timeout'))},this.timeoutMs)})
      const result=await Promise.race([this.plan(snapshot,{signal:job.controller.signal}),timeout])
      if (this.closed || job.controller.signal.aborted || !this.enabled || this.director.mode!=='auto' ||
        this.scheduler.muted || this.scheduler.hostSpeaking ||
        this.director.revision!==job.revision || this.director.candidate) return
      const elapsed=Math.max(0,this.now()-job.started)
      this.apply(result,snapshot,elapsed)
      this.lastKey=this.key(this.context())
    } catch (error) {
      if (!this.closed && (!job.controller.signal.aborted || job.timedOut) &&
        this.director.revision===job.revision) {
        const code=job.timedOut?'timeout':error instanceof ParticipationError && Object.hasOwn(errorMessages,error.code)?error.code:'unknown'
        this.director.record('hold',code==='timeout'?'participation_timeout':'participation_error',
          {explanation:errorMessages[code],errorCode:code})
      }
    } finally {
      clearTimeout(timer)
      if(job.thoughtId && this.thought.value?.id===job.thoughtId)this.thought.value.reviewed=true
      if(this.job===job)this.job=null
      if(this.pending){this.pending=false;this.notify()}
    }
  }
  apply(result,snapshot,decisionMs) {
    const d=this.director,s=this.scheduler,u=d.utterance
    if (!result || !['wait','reply_host','reply_viewer','reply_followup','react','stop'].includes(result.action) ||
      typeof result.reason!=='string' || !result.reason.trim() || result.reason.length>180 ||
      typeof result.text!=='string' || result.text.length>800) throw new Error('Invalid action')
    const animation=normalizePerformance(result)
    result={...result,...animation,warnings:[...(result.warnings??[]),...animation.warnings]}
    if (result.warnings.length) d.record('hold','performance_adjusted',{
      explanation:result.warnings.includes('motion_dropped') || result.warnings.includes('performance_dropped') || result.warnings.includes('components_dropped')
        ? '这次动作有一部分不合规，已略过；接话照常。' : result.warnings.includes('thought_dropped') ? '这次便签格式不合规，已略过；原来的决定照常。' : '动作字段的位置已校正，按安全范围执行。',
      performanceWarnings:result.warnings})
    if (snapshot.hostOpportunity && u?.id === snapshot.latestHost?.id) this.observedUtterance=u.id
    const details={explanation:result.reason,decisionMs}
    this.lastDecision={action:result.action,reason:result.reason,decisionMs,at:this.now()}
    if(snapshot.pendingThought && (snapshot.hostOpportunity || snapshot.pendingOpportunity)) {
      if(result.action!=='reply_followup')this.thought.take(snapshot.pendingThought.id,this.scene.topic)
    }
    if(['wait','react'].includes(result.action) && result.thought && snapshot.hostOpportunity && !snapshot.pendingOpportunity) {
      if(this.thought.set(result.thought,{topic:this.scene.topic,utterance:u.id,active:snapshot.active,activeTurn:snapshot.activeTurn}))
        d.record('hold','participation_deferred',{explanation:'我先记着这个想法：'+this.thought.value.text})
    }
    if(result.action==='wait') {d.record('hold','participation_wait',details);return}
    if(result.action==='react') {
      if(!snapshot.hostOpportunity || !u || this.now()-u.endedAt>=this.opportunityMs || s.active || result.text.length>40 || this.now()-d.lastParticipation<d.participationCooldownMs)return
      d.lastParticipation=this.now();d.consumedUtterance=u.id
      this.onReaction(result)
      d.record('hold','participation_reaction',details);return
    }
    if(result.action==='stop') {
      if(!snapshot.hostOpportunity || !s.active || !u || this.now()-u.endedAt>=this.opportunityMs)return
      s.interrupt();this.thought.clear();d.consumedUtterance=u.id;d.intent='stop';d.candidate=null
      d.record('stop','participation_stop',details);return
    }
    if(!result.text.trim())return
    if(result.action==='reply_followup') {
      const thought=this.thought.snapshot(this.scene.topic)
      if(!snapshot.pendingOpportunity || !thought || result.thoughtId!==thought.id || thought.id!==snapshot.pendingThought?.id ||
        result.hostIntent!=='spontaneous' || s.active || s.hostSpeaking || !u?.final || u.id!==thought.utterance ||
        this.now()-d.lastParticipation<d.participationCooldownMs) {this.thought.clear();return}
      d.candidate={id:++d.nextDecision,revision:d.revision,text:u.text,intent:'opportunity',thoughtId:thought.id,
        expiresAt:Math.min(this.now()+1500,thought.expiresAt),preparedReply:result.text,performance:result.performance,motion:result.motion,decisionMs}
      d.record('reply','participation_followup',details);return
    }
    if(result.action==='reply_host') {
      if(!snapshot.hostOpportunity || !u?.final || u.endedAt===null || u.id===d.consumedUtterance ||
        this.now()-u.endedAt>=this.opportunityMs)return
      // Direct questions are not throttled by the proactive budget; the model receives this state.
      if(result.hostIntent !== 'invited' && this.now()-d.lastParticipation<d.participationCooldownMs) {
        d.record('hold','participation_cooldown',{explanation:'我刚补充过一次，这次先让主播继续。'});return
      }
      // An invitation has the same takeover semantics as the director's explicit handover.
      // Spontaneous additions never replace an answer already being spoken.
      if(s.active) { if(result.hostIntent!=='invited')return; s.interrupt() }
      d.candidate={id:++d.nextDecision,revision:d.revision,text:u.text,intent:result.hostIntent === 'invited' ? 'handover' : 'opportunity',
        expiresAt:this.now()+1500,preparedReply:result.text,performance:result.performance,motion:result.motion,decisionMs}
    } else {
      if(!d.viewerWindow || s.active)return
      const item=s.eligibleViewers().find(x=>x.id===result.targetId && x.platform===result.platform)
      if(!item || !snapshot.eligibleViewers.some(x=>x.id===item.id && x.platform===item.platform))return
      d.candidate={id:++d.nextDecision,revision:d.revision,source:'viewer',messageId:item.id,platform:item.platform,
        text:item.text,intent:'viewer',expiresAt:Math.min(this.now()+1500,item.receivedAt+s.ttlMs),
        preparedReply:result.text,performance:result.performance,motion:result.motion,decisionMs,semanticSelection:true}
    }
    d.record('reply','participation_reply',details)
  }
  close() {this.closed=true;this.invalidate({clearThought:true})}
}
