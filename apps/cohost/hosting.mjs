// Short continuations require a delivered spoken turn. Silent reviews cannot hot-poll.
export function hostingPlan(result, spoken=false) {
  const hostingPace=['continue','yield'].includes(result.hostingPace)?result.hostingPace:undefined
  const seconds=result.revisitAfterSeconds,continuing=hostingPace==='continue'
  const valid=Number.isSafeInteger(seconds) && (seconds===0 ||
    (continuing?spoken && seconds>=1 && seconds<=10:seconds>=(spoken?5:15) && seconds<=120))
  return {hostingPace,revisitAfterSeconds:valid?seconds:undefined}
}

// Quoted or hypothetical instructions cannot restore a paused run, even if the model misclassifies them.
export function allowsHostingControl(text) {
  return typeof text==='string' && !/[“”「」『』"‘’]|如果|假如|假设|要是|例如|比如|这句话|这段话|(?:他|她|有人|观众)说/u.test(text)
}
export function allowsHostingStart(text) {
  return allowsHostingControl(text) && !/(?:别|不要|不用|停止|暂停|关闭|取消|先不).{0,8}(?:自主|主持|托管|自己播|自己聊|开启|开播)/u.test(text)
}

// Human controls revoke a run. Runtime revisions only revoke its pending decisions.
export class Hosting {
  constructor({now=Date.now,gapMs=6000,maxSteps=12,maxReviews=12,maxDurationMs=600000,continuous=true,idleAfterMs=30000}={}) {
    Object.assign(this,{now,gapMs,maxSteps,maxReviews,maxDurationMs,continuous,idleAfterMs})
    this.controlRevision=0;this.failures=0;this.idleSince=this.now();this.quietSince=this.idleSince
    this.revision=0;this.state='off';this.topic='';this.steps=0;this.quiet=0;this.turn=null;this.reason='';this.automatic=true
    this.role='listen';this.pace='yield';this.nextReviewAt=null;this.reviews=0;this.lastInputAt=null;this.lastHandoff=null;this.audienceWaitStartedAt=null
    this.waitStartedAt=null;this.lastPlaybackAt=null;this.wakeup=null;this.previousDecision=null
    this.programReady=false;this.observation=null;this.observations=0;this.observationRetryAt=0
  }
  get running(){return this.state==='running'}
  get engaged(){return this.running || this.state==='observing' || (this.continuous && this.state==='waiting')}
  get canReview(){return this.continuous || this.reviews<this.maxReviews}
  acceptsControl(revision){return Number.isSafeInteger(revision) && revision>=this.controlRevision && revision<=this.revision}
  status(){return {revision:this.revision,state:this.state,topic:this.topic,steps:this.steps,maxSteps:this.maxSteps,reason:this.reason,automatic:this.automatic,
    continuous:this.continuous,awarenessMode:this.continuous?'continuous':'scheduled',role:this.role,pace:this.pace,lastHandoff:this.lastHandoff,nextReviewAt:this.nextReviewAt,
    observation:this.observation?{...this.observation}:null,observations:this.observations}}
  observe(){
    if(!this.automatic || this.state!=='off')return
    this.start('',{control:false});this.state='observing';this.role='listen';this.dueAt=this.now()+this.gapMs
    this.wakeup=this.continuous?null:{reason:'idle',scheduledAt:this.dueAt,waitStartedAt:this.now()}
  }
  start(topic='',{control=true}={}) {
    this.revision++;this.state='observing';this.topic=topic;this.steps=0;this.quiet=0;this.turn=null
    if(control)this.controlRevision=this.revision
    this.failures=0;this.idleSince=this.now();this.quietSince=this.idleSince
    this.startedAt=this.now();this.lastInputAt=this.now();this.dueAt=this.now();this.reason='';this.reviewed=false
    this.role='listen';this.pace='yield';this.nextReviewAt=null;this.reviews=0;this.lastHandoff=null
    this.waitStartedAt=null;this.previousDecision=null;this.wakeup={reason:'start',scheduledAt:this.dueAt,waitStartedAt:null}
    this.programReady=false;this.observation=null;this.observations=0;this.observationRetryAt=0
    if(this.continuous)this.wakeup=null
  }
  pause(reason='manual') {
    if(this.state==='off' || this.state==='completed')return
    this.revision++;this.state='paused';this.reason=reason;this.turn=null;this.nextReviewAt=null;this.lastHandoff=null
    this.controlRevision=this.revision
    this.waitStartedAt=null;this.wakeup=null
    this.programReady=false;this.observationRetryAt=0
  }
  stop(){this.revision++;this.controlRevision=this.revision;this.state='off';this.turn=null;this.reason='';this.automatic=false;this.nextReviewAt=null;this.lastHandoff=null;this.waitStartedAt=null;this.wakeup=null;this.programReady=false;this.observationRetryAt=0}
  resume(){
    if(this.state!=='paused' && this.state!=='waiting')return false
    if(!this.continuous && this.steps>=this.maxSteps){this.state='completed';this.reason='limit';return false}
    this.revision++;this.state='observing';this.quiet=0;this.reviewed=false;this.dueAt=this.now();this.startedAt=this.now();this.reason=''
    this.controlRevision=this.revision;this.failures=0;this.idleSince=this.now();this.quietSince=this.idleSince
    this.waitStartedAt=null;this.previousDecision=null;this.wakeup={reason:'resume',scheduledAt:this.dueAt,waitStartedAt:null}
    this.programReady=false;this.observation=null;this.observationRetryAt=0
    if(this.continuous)this.wakeup=null
    this.nextReviewAt=null;this.reviews=0;this.lastHandoff=null;return true
  }
  input(){
    if(this.state==='completed' && this.automatic)this.start('',{control:false})
    if(!['running','observing','waiting'].includes(this.state))return
    this.revision++;this.quiet=0;this.reviewed=false;this.dueAt=this.now()+this.gapMs
    this.state='observing';this.reason='';this.nextReviewAt=null;this.reviews=0;this.lastInputAt=this.now();this.startedAt=this.now();this.lastHandoff=null
    this.idleSince=this.now();this.quietSince=this.idleSince;this.failures=0
    this.waitStartedAt=null;this.previousDecision=null;this.wakeup={reason:'input',scheduledAt:this.dueAt,waitStartedAt:null}
    this.programReady=false;this.observation=null;this.observationRetryAt=0
    if(this.continuous)this.wakeup=null
  }
  cancelReview(){
    this.lastHandoff=null;this.idleSince=this.now();this.quietSince=this.idleSince
    this.waitStartedAt=null;this.wakeup=null
    this.programReady=false
    if(this.state!=='waiting' || this.nextReviewAt===null)return
    this.nextReviewAt=null;this.reason='decision';this.revision++
  }
  wait(reason='decision',seconds=0,pace='yield',delivered=false,startedAt=this.now()){
    if(!this.engaged)return
    this.state='waiting';this.reason=reason;this.reviewed=true;this.revision++;this.nextReviewAt=null
    // Continuous hosting keeps observing; only finite runs accept a scheduled review.
    const plan=hostingPlan({hostingPace:pace,revisitAfterSeconds:seconds},delivered)
    this.pace=plan.hostingPace??'yield'
    this.idleSince=startedAt
    this.waitStartedAt=startedAt;this.wakeup=null
    this.programReady=false
    if(this.continuous){this.reason='observing';return}
    if(plan.revisitAfterSeconds>0 && this.canReview){
      this.nextReviewAt=startedAt+seconds*1000;this.reason='scheduled'
    }
  }
  failed(code='unknown') {
    if(!this.engaged && this.state!=='waiting')return
    if(!this.continuous || code==='credentials' || ++this.failures>3){this.pause('error');return}
    this.state='observing'
    this.wait('retry');this.reason='retry'
    this.observationRetryAt=this.now()+Math.min(120,30*2**(this.failures-1))*1000
  }
  decide(result,revision=this.revision,delivered=false,startedAt=this.now()){
    if(!this.engaged || revision!==this.revision)return false
    this.failures=0
    this.observationRetryAt=0
    if(['lead','support','listen'].includes(result.hostingIntent))this.role=result.hostingIntent
    if(typeof result.hostingTopic==='string' && result.hostingTopic.trim().length<=120)this.topic=result.hostingTopic.trim()
    this.wait('decision',result.revisitAfterSeconds,result.hostingPace,delivered,startedAt)
    this.previousDecision={at:this.now(),action:result.action??(delivered?'delivered_reply':'wait'),
      reason:typeof result.reason==='string'?result.reason.slice(0,180):'',role:this.role,pace:this.pace,
      plannedWaitMs:this.nextReviewAt===null?null:Math.max(0,this.nextReviewAt-this.waitStartedAt)}
    return true
  }
  review(revision){
    if(!this.engaged || revision!==this.revision)return
    this.reviewed=true;this.reviews++;this.programReady=false
  }
  canObserve(scheduler){
    return this.continuous && this.engaged && !this.programReady && !this.turn && !scheduler.active && !scheduler.hostSpeaking && !scheduler.muted && this.now()>=this.observationRetryAt
  }
  acceptObservation(value,revision){
    if(!this.continuous || !this.engaged || revision!==this.revision || !['wait','consider_speaking'].includes(value?.choice) ||
      typeof value.reason!=='string' || !value.reason.trim() || value.reason.length>80 || typeof value.idea!=='string' || value.idea.length>120 ||
      value.choice==='consider_speaking' && !value.idea.trim())return false
    this.observation={at:this.now(),choice:value.choice,reason:value.reason,idea:value.idea};this.observations++
    this.programReady=value.choice==='consider_speaking'
    if(this.programReady){this.state='observing';this.reviewed=false;this.revision++}
    else {this.state='waiting';this.reason='observing';this.failures=0}
    return this.programReady
  }
  track(turn){
    if(!this.engaged || turn.input.source==='preview' || turn.listening)return
    this.waitStartedAt=null;this.wakeup=null
    this.quietSince=this.now()
    if(turn.input.source==='program')this.state='running'
    this.turn={id:turn.id,revision:this.revision,program:turn.input.source==='program',controller:turn.controller,
      hostingIntent:turn.hostingIntent,hostingTopic:turn.hostingTopic,hostingPace:turn.hostingPace,revisitAfterSeconds:turn.revisitAfterSeconds,stream:turn.replyStream}
  }
  tick(scheduler,available=true){
    if(!this.engaged && this.state!=='waiting')return
    if(!available){this.pause('stage');return}
    if(scheduler.muted){this.pause('muted');return}
    if(this.turn && scheduler.active?.id!==this.turn.id){
      const turn=this.turn;this.turn=null
      if(scheduler.lastCompletedTurn!==turn.id){
        if(this.continuous && !['host_stop','hosting_control'].includes(turn.controller?.signal.reason))this.failed('delivery')
        else this.pause('interrupted')
        return
      }
      this.steps++
      this.lastPlaybackAt=scheduler.lastCompletedAt
      this.quietSince=Math.max(this.quietSince,this.lastPlaybackAt)
      if(turn.program && turn.revision===this.revision)this.quiet++
      this.revision++;this.reviewed=false;this.dueAt=this.now()+this.gapMs
      if(!this.continuous && this.steps>=this.maxSteps){this.state='completed';this.reason='limit';this.nextReviewAt=null;return}
      // Apply the delivered plan only if no newer input superseded it.
      if(turn.revision===this.revision-1){
        if(!this.continuous && turn.stream?.hostingClosingRequired && !turn.stream.hostingClosing){
          this.failed('closing');return // Never reuse the opening draft after an incomplete closing.
        }
        const closing=turn.stream?.hostingClosingRequired ? turn.stream.hostingClosing:null
        this.lastHandoff=closing?.handoff??null
        this.audienceWaitStartedAt=this.lastHandoff==='audience'?scheduler.lastCompletedAt:null
        this.decide({...turn,...closing},this.revision,true,scheduler.lastCompletedAt)
      }
    }
    if(!this.continuous && (this.now()-this.startedAt>=this.maxDurationMs || (this.reviews>=this.maxReviews && this.state==='waiting')) && !scheduler.active){
      this.state='completed';this.reason='limit';this.nextReviewAt=null;this.revision++;return
    }
    if(scheduler.active || scheduler.hostSpeaking){
      this.idleSince=this.now();this.quietSince=this.idleSince
      return
    }
    if(this.continuous)return
    if(this.state==='waiting' && this.nextReviewAt!==null && this.now()>=this.nextReviewAt && !scheduler.active && !scheduler.hostSpeaking){
      this.wakeup={reason:this.reason,scheduledAt:this.nextReviewAt,waitStartedAt:this.waitStartedAt}
      this.state='observing';this.reason='';this.nextReviewAt=null;this.reviewed=false;this.dueAt=this.now();this.revision++
    }
  }
  context(scheduler,at=this.now()){
    return {...this.status(),quietTurns:this.quiet,reviewRemaining:this.continuous?null:Math.max(0,this.maxReviews-this.reviews),
      audienceWaitMs:this.lastHandoff==='audience' && Number.isFinite(this.audienceWaitStartedAt)?Math.max(0,at-this.audienceWaitStartedAt):null,
      withoutInputMs:this.lastInputAt===null?0:Math.max(0,at-this.lastInputAt),
      quietMs:scheduler.active || scheduler.hostSpeaking?0:Math.max(0,at-this.quietSince),
      pauseElapsedMs:this.waitStartedAt===null?null:Math.max(0,at-this.waitStartedAt),
      sincePlaybackMs:this.lastPlaybackAt===null?null:Math.max(0,at-this.lastPlaybackAt),
      wakeup:this.wakeup?{...this.wakeup,overdueMs:Math.max(0,at-this.wakeup.scheduledAt)}:null,
      previousDecision:this.previousDecision?{...this.previousDecision}:null,
      opportunity:this.engaged && this.canReview && (this.continuous?this.programReady:!this.reviewed && this.now()>=this.dueAt) && !this.turn && !scheduler.active && !scheduler.hostSpeaking && !scheduler.muted}
  }
}
