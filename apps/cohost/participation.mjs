import { normalizePerformance, ParticipationError } from './participation-model.mjs'
import { PendingThought } from './pending-thought.mjs'
import { TaskScope } from './task-scope.mjs'
import { acknowledgmentExtension, isBackchannel } from '../../packages/cohost-contracts/floor.ts'
import { AnswerPreparation } from './answer-preparation.mjs'
import { liveClock } from './live-clock.mjs'
import { OpeningPreparation } from './opening-preparation.mjs'
import { directorLookupMs } from './director-tools.mjs'
import { allowsHostingControl, allowsHostingStart } from './hosting.mjs'
const errorMessages={
  network:'这次没有连上模型服务，我先听着；下一句再试。',
  timeout:'这次模型回应超时，我先听着；下一句再试。',
  credentials:'模型服务拒绝了当前密钥，请检查本机配置。',
  rate_limit:'模型服务暂时限流，我先听着；下一句再试。',
  task_capacity:'上一批请求还在退出，我先听着；稍后有新的话再试。',
  provider:'模型服务暂时出错，我先听着；下一句再试。',
  truncated:'这次决定输出被截断，没拿到完整结果；下一句再试。',
  tool:'这次没有收到有效的行动决定；下一句再试。',
  json:'这次决定的格式无法解析；下一句再试。',
  arguments:'这次决定的字段不合规，未执行；下一句再试。',
  unknown:'这次调用或结果处理出错，我先听着；下一句再试。',
}
// Human input uses one generation. Quiet continuous hosting first observes without speaking.
export class Participation {
  constructor({ director, scheduler, scene, plan, observe, observationGapMs=1000, prepareSpeech, preparationText = (_utterance,listening) => listening.text, history = () => [], continuity, hosting, character = () => '', onReaction = () => {}, onCoaching = () => {}, enabled = false, openingPreparationEnabled = false, answerPreparationEnabled = false, endOfSpeechPreparationEnabled = true, now = Date.now, debounceMs = 250, timeoutMs = 4500, opportunityMs = 6000, viewerIntervalMs = 3000, thoughtOptions = {} } = {}) {
    Object.assign(this,{director,scheduler,scene,plan,history,onReaction,now,debounceMs,timeoutMs,opportunityMs})
    Object.assign(this,{continuity,character,hosting,onCoaching})
    Object.assign(this,{observe,observationGapMs});this.lastObservationAt=-Infinity
    this.prepareSpeech=prepareSpeech
    this.enabled = enabled; this.pending = false; this.job = null; this.timer = null
    this.observedUtterance = null; this.lastKey = null; this.closed = false; this.lastDecision = null
    this.viewerIntervalMs=viewerIntervalMs;this.nextViewerAt=-Infinity
    this.thought=new PendingThought({...thoughtOptions,now})
    // A short-reaction review can overlap silent first-answer preparation.
    // Cancelled transports keep their slot until their abort finishes.
    // This lane never shares capacity with memory maintenance or audio output.
    this.tasks=new TaskScope({name:'participation',maxRunning:2,maxWaiting:1,now})
    this.answerPreparation=new AnswerPreparation({tasks:this.tasks,plan,prepareSpeech,now,timeoutMs})
    this.openingPreparation=new OpeningPreparation({tasks:this.tasks,plan,prepareSpeech,now,
      canPrepareSpeech:()=>!this.job?.listening && !director.candidate?.listening && !scheduler.active})
    this.openingPreparationEnabled=openingPreparationEnabled
    this.answerPreparationEnabled=answerPreparationEnabled
    this.endOfSpeechPreparationEnabled=endOfSpeechPreparationEnabled
    this.preparationText=preparationText
    director.followUp={validate:id=>this.thought.snapshot(scene.topic)?.id===id,
      consume:id=>this.thought.take(id,scene.topic)}
    director.hosting=hosting
    scheduler.hostingViewers=()=>this.enabled && director.mode==='auto' && Boolean(hosting && ['running','observing','waiting'].includes(hosting.state))
    director.semanticViewer = enabled
    director.semanticHost = enabled && Boolean(plan)
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
    this.director.semanticHost=value
    this.thought.clear()
    this.director.consumedUtterance=this.director.utterance?.id ?? null
    this.invalidate(); this.director.invalidate('participation_changed')
    this.lastKey=null; this.notify()
  }
  invalidate({clearThought=false,preserveAnswer=false,preserveOpening=false,preserveFloor=false}={}) {
    clearTimeout(this.timer); this.timer=null; this.pending=false
    const floor=this.job?.floor,d=this.director
    if(preserveFloor && !clearThought && floor && !this.job.controller.signal.aborted &&
      floor.utterance===d.utterance?.id && floor.turn===this.scheduler.active?.id &&
      floor.text===d.listening.text && !['stop','handover'].includes(d.intent)) {
      // Finalization alone does not invalidate a review of exactly this input/output.
      this.job.revision=d.revision
    } else this.job?.controller.abort()
    if(preserveFloor)this.nextFloorAt=this.now()
    if(!preserveAnswer){this.answerPreparation.clear();this.finishingUtterance=null}
    if(!preserveOpening){this.openingPreparation.clear();this.openingInputState=null}
    if(clearThought){this.thought.clear();this.director.listening.reset()}
  }
  listeningOffer() {
    const d=this.director,s=this.scheduler,u=d.utterance
    if(this.closed || !this.enabled || !this.plan || d.mode!=='auto' || s.muted || s.active ||
      d.candidate || d.intent==='stop' || !u || u.final || u.id===d.consumedUtterance ||
      this.now()-d.lastListening<d.listeningCooldownMs)return null
    return d.listening.offer()
  }
  floorOffer() {
    const d=this.director,s=this.scheduler,u=d.utterance,text=d.listening.text
    if(this.closed || !this.enabled || !this.plan || d.mode!=='auto' || s.muted || d.intent==='stop' ||
      !s.active || s.active.listening || !u || (u.final && this.lastFloorUtterance!==u.id) || u.id===this.observedUtterance ||
      u.id===d.consumedUtterance || text.length<2 || isBackchannel(text))return null
    const key=JSON.stringify([s.active.id,u.id,text,Boolean(u.final)])
    if(key===this.lastFloorKey || this.now()<(this.nextFloorAt??0))return null
    return {key,text,utterance:u.id,turn:s.active.id}
  }
  context() {
    this.discardIfPaused()
    const {director:d,scheduler:s}=this
    const u=d.utterance
    const hostOpportunity=Boolean(u?.final && u.endedAt !== null && u.id !== d.consumedUtterance && u.id !== this.observedUtterance && !['stop','backchannel'].includes(d.intent) &&
      this.now()-u.endedAt < this.opportunityMs)
    const viewerWindow=(d.viewerWindow || Boolean(this.hosting?.engaged)) && this.hosting?.state!=='waiting' &&
      (!this.hosting?.engaged || this.hosting.canReview)
    const eligibleViewers=viewerWindow ? s.eligibleViewers() : []
    const clock=liveClock(this.now())
    const snapshot={ clock,scene:this.scene.snapshot(), currentTopic:this.scene.topic, history:this.history().map(x=>({...x})), hostOpportunity, latestHost:u ? {...u} : null,
      proactiveCooldownMs:this.hosting?.engaged?0:Math.max(0,d.participationCooldownMs-(this.now()-d.lastParticipation)),
      viewerWindow, active:Boolean(s.active), activeTurn:s.active?.id??null, completedTurn:s.lastCompletedTurn,completedAt:Number.isFinite(s.lastCompletedAt)?s.lastCompletedAt:null,hostSpeaking:s.hostSpeaking,
      eligibleViewers:eligibleViewers.slice(0,16).map(({id,platform,userId,text})=>({id,platform,userId,text})) }
    snapshot.hosting=this.hosting?.context(s,clock.nowMs)
    if(s.active) {
      const turn=s.active,offset=turn.playedChars??0
      snapshot.speaking={turn:turn.id,delivered:turn.answer.slice(0,offset).slice(-400),
        current:turn.playingSegment??null,planned:turn.answer.slice(offset,offset+600),
        deliveryNote:'current may be partly heard; planned is not confirmed delivery',floor:turn.floorState??'play'}
    }
    snapshot.programOpportunity=Boolean(snapshot.hosting?.opportunity)
    snapshot.pendingThought=this.thought.snapshot(this.scene.topic)
    snapshot.pendingOpportunity=this.thought.ready({topic:this.scene.topic,...snapshot})
    if(hostOpportunity && !s.active)snapshot.preparedOpenings=this.openingPreparation.offer(this.openingInput(u.text))
    if(this.continuity) {
      Object.assign(snapshot,this.continuity.context(this.character(),this.scene.topic))
      // Runtime authority stays outside the model's serializable snapshot.
      Object.defineProperty(snapshot,'continuationContext',{value:{generation:this.continuity.generation,
        characterId:this.character(),topic:this.scene.topic,host:hostOpportunity?snapshot.latestHost:null,
        offered:snapshot.continuations.map(item=>item.id)}})
    }
    return snapshot
  }
  key(snapshot) {
    return JSON.stringify([this.director.revision,this.scheduler.version,
      snapshot.hosting?.revision, snapshot.programOpportunity, snapshot.hostOpportunity ? [] : snapshot.eligibleViewers.map(x=>[x.platform,x.id]),snapshot.hostOpportunity,snapshot.pendingOpportunity?snapshot.pendingThought.id:null])
  }
  syncAnswerPreparation() {
    const d=this.director,s=this.scheduler,u=d.utterance,l=d.listening,a=this.answerPreparation
    if(this.finishingUtterance===u?.id && !u?.final && l.pauseAt===null){this.finishingUtterance=null;a.clear()}
    const finishing=this.finishingUtterance===u?.id
    const allowed=(this.answerPreparationEnabled || finishing) && !this.closed && this.enabled && this.plan && d.mode==='auto' && !s.muted && (!s.active || s.active.listening) &&
      !['stop','backchannel'].includes(d.intent) && u && u.id!==d.consumedUtterance
    const text=u?.final?u.text:this.preparationText(u,l)
    if(!allowed || text===null || (a.current && !a.matches(u.id,text)) || (!u?.final && !l.quiet && !finishing))a.clear()
    if(!allowed || text===null)return false
    if(u.final) {
      if(u.endedAt===null || s.hostSpeaking || s.active || this.job || d.candidate?.preparedReply || d.candidate?.listening)return false
      const item=a.take(u.id,u.text)
      if(!item)return false
      const snapshot=this.context()
      this.apply(item.result,snapshot,this.now()-item.startedAt)
      if(d.candidate) {
        Object.assign(d.candidate,{replyStream:item.result.replyStream,preparedSpeech:item.speech,
          timings:{inputAt:u.endedAt,decisionStartedAt:item.startedAt,decisionReadyAt:item.readyAt,answerPrepared:true}})
        this.attachOpening(item.result)
        d.record('hold','answer_preparation_reused',{explanation:'识别已确认，使用停顿期间准备的完整回答。'})
      }else {item.result.replyStream?.close();item.speech?.close()}
      this.lastKey=this.key(this.context())
      return true
    }
    // The first pause signal arrives after 200 ms. Require another 450 ms of renewed silence.
    // This prepares an answer only. Final ASR and the ordinary director still authorize speech.
    const settled=(finishing || l.quiet && l.quietSince!==null && this.now()-l.quietSince>=450 && this.now()-l.updatedAt>=300) && text.length>=8
    if(!finishing && settled && this.job?.listening) {
      this.job.controller.abort();return true
    }
    if(!finishing && settled && d.candidate?.listening) d.invalidate('full_answer_preparing')
    // Local segment completion must not wait behind a still useful short reaction.
    // The independent draft has no playback authority and leaves that reaction intact.
    if((!this.job || finishing && this.job.listening) && (!d.candidate || finishing && d.candidate.listening) && settled) {
      const snapshot=this.context()
      snapshot.hostOpportunity=true;snapshot.hostSpeaking=false;snapshot.active=false;snapshot.activeTurn=null;snapshot.programOpportunity=false;snapshot.pendingOpportunity=false
      delete snapshot.speaking
      snapshot.eligibleViewers=[];snapshot.latestHost={...u,text,final:false,endedAt:null}
      snapshot.preparedOpenings=this.openingPreparation.offer(this.openingInput(text))
      snapshot.answerPreparation=true
      snapshot.endOfSpeechPreparation=finishing
      a.start(snapshot)
    }
    return !u.final && Boolean(a.current)
  }
  recognitionFinishing(id) {
    // Only the authenticated microphone's local VAD completion enters this lane.
    // Keep short reactions and ordinary active speech in their existing lanes.
    if(!this.endOfSpeechPreparationEnabled || this.director.utterance?.id!==id || this.director.utterance.final || this.scheduler.active)return
    this.finishingUtterance=id
    this.notify()
  }
  awaitingAnswer() {
    const u=this.director.utterance,a=this.answerPreparation
    return Boolean(u?.final && a.matches(u.id,u.text) && !a.current.settled)
  }
  notify() {
    this.discardIfPaused()
    this.syncOpeningPreparation()
    if(this.syncAnswerPreparation())return
    const earlyFloor=this.job?.floor
    if(earlyFloor && earlyFloor.text.length<4 && this.director.listening.text.length>=4 &&
      earlyFloor.utterance===this.director.utterance?.id && earlyFloor.turn===this.scheduler.active?.id) {
      // A two-character probe must not block the first meaningful phrase.
      // Only this early probe is replaced, so ordinary revisions cannot starve reviews.
      this.nextFloorAt=this.now();this.job.controller.abort()
    }
    if(this.floorOffer() && !this.job && !this.timer) {
      this.timer=setTimeout(()=>{this.timer=null;void this.run()},100)
      this.timer.unref?.();return
    }
    if(this.job?.floor && !this.job.controller.signal.aborted)return
    if(this.job?.listening && this.director.listening.relevant(this.job.listening.text))return
    if(this.listeningOffer() && !this.job && !this.timer) {
      this.timer=setTimeout(()=>{this.timer=null;void this.run()},Math.min(this.debounceMs,80))
      this.timer.unref?.();return
    }
    if (this.closed || !this.enabled || !this.plan || this.director.mode !== 'auto' || this.scheduler.muted ||
      this.scheduler.hostSpeaking || this.director.candidate || this.director.intent === 'stop') return
    const snapshot=this.context()
    if(this.canObserve(snapshot)){
      this.timer=setTimeout(()=>{this.timer=null;void this.run()},0)
      this.timer.unref?.();return
    }
    if (!snapshot.hostOpportunity && !snapshot.eligibleViewers.length && !snapshot.pendingOpportunity && !snapshot.programOpportunity) return
    if(!snapshot.hostOpportunity && !snapshot.pendingOpportunity && !snapshot.programOpportunity && this.now()<this.nextViewerAt)return
    const key=this.key(snapshot)
    if (key===this.lastKey) return
    if (this.job) {
      if (key!==this.job.key) {
        this.pending=true
        // New background messages join the next batch. Host/control changes still cancel immediately.
        if(this.director.revision!==this.job.revision || this.scheduler.version!==this.job.version || snapshot.hostOpportunity || snapshot.pendingOpportunity)
          this.job.controller.abort()
      }
      return
    }
    if (this.timer) return
    this.timer=setTimeout(()=>{this.timer=null;void this.run()},this.debounceMs)
    this.timer.unref?.()
  }
  async run() {
    this.discardIfPaused()
    if(this.syncAnswerPreparation())return
    const floor=this.floorOffer()
    if(floor && !this.job)return this.runFloor(floor)
    const listening=this.listeningOffer()
    if(listening && !this.job)return this.runListening(listening)
    if (this.closed || !this.enabled || this.director.mode!=='auto' || this.scheduler.muted ||
      this.scheduler.hostSpeaking || this.director.candidate || this.director.intent==='stop' || this.job) return
    const snapshot=this.context(), key=this.key(snapshot)
    if(this.canObserve(snapshot)){
      if(await this.runObservation(snapshot))return this.run()
      return
    }
    if ((!snapshot.hostOpportunity && !snapshot.eligibleViewers.length && !snapshot.pendingOpportunity && !snapshot.programOpportunity) || key===this.lastKey) return
    if(!snapshot.hostOpportunity && !snapshot.pendingOpportunity && !snapshot.programOpportunity && this.now()<this.nextViewerAt)return
    const viewerOnly=!snapshot.hostOpportunity && !snapshot.pendingOpportunity && !snapshot.programOpportunity
    if(viewerOnly)this.nextViewerAt=this.now()+this.viewerIntervalMs
    // At most one quiet review, even if the provider fails or the snapshot is interrupted.
    const job={key,controller:new AbortController(),revision:this.director.revision,version:this.scheduler.version,started:this.now(),thoughtId:snapshot.pendingOpportunity?snapshot.pendingThought.id:null}
    this.job=job;this.lastKey=key;this.pending=false
    if(this.hosting?.engaged)this.hosting.review(snapshot.hosting.revision)
    let result
    try {
      const preparation=this.answerPreparation
      const matched=snapshot.hostOpportunity && preparation.matches(snapshot.latestHost.id,snapshot.latestHost.text)
      const pending=matched && preparation.current.endOfSpeechPreparation && !preparation.current.settled ? preparation.current : null
      if(matched && !pending)await preparation.current.done
      if(job.controller.signal.aborted)return
      let prepared=preparation.take(snapshot.latestHost?.id,snapshot.latestHost?.text??'')
      const task=prepared ? null : this.tasks.start({key,kind:'participation-review',signal:job.controller.signal,timeoutMs:this.timeoutMs,maxTimeoutMs:Math.max(this.timeoutMs,directorLookupMs),
        run:options=>this.plan(snapshot,{...options,onLookup:()=>{if(options.extendTimeout(Math.max(this.timeoutMs,directorLookupMs)))job.lookup=true}}),discard:value=>value?.replyStream?.close()})
      let outcome
      if(prepared)outcome={state:'completed',value:prepared.result}
      else if(pending) {
        // The normal review starts on time. Only an identical answer can win early.
        // A speculative wait never delays or replaces the normal result.
        const ordinary=task.done.then(value=>({outcome:value}))
        const speculative=pending.done.then(()=>{
          if(job.controller.signal.aborted || preparation.current!==pending)return ordinary
          return pending.result?{draft:pending}:ordinary
        })
        const winner=await Promise.race([ordinary,speculative])
        if(winner.draft)prepared=preparation.take(snapshot.latestHost.id,snapshot.latestHost.text)
        if(prepared) {
          outcome={state:'completed',value:prepared.result}
          task.cancel('superseded')
          // A simultaneously completed normal result already transferred ownership.
          // Close it explicitly even when cancel() can no longer cancel its task.
          void task.done.then(value=>value.value?.replyStream?.close())
        }else {
          outcome=winner.outcome ?? (await ordinary).outcome
          if(preparation.current===pending)preparation.clear()
        }
      }else outcome=await task.done
      job.prepared=prepared
      if(outcome.state==='cancelled')return
      if(outcome.state==='failed') {
        job.timedOut=outcome.reason==='timeout'
        if(job.timedOut)job.controller.abort()
        throw outcome.error??new ParticipationError(outcome.reason==='capacity'?'task_capacity':'timeout')
      }
      result=outcome.value
      if (this.closed || job.controller.signal.aborted || !this.enabled || this.director.mode!=='auto' ||
        this.scheduler.muted || this.scheduler.hostSpeaking ||
        this.director.revision!==job.revision || this.director.candidate) return
      const elapsed=Math.max(0,this.now()-job.started)
      this.apply(result,snapshot,elapsed,{lookup:job.lookup})
      if(snapshot.programOpportunity && !this.director.candidate && this.hosting?.engaged && snapshot.hosting.revision===this.hosting.revision){
        this.hosting.wait()
        this.director.record('hold','hosting_invalid_opportunity',{explanation:'这次决定不符合当前发言条件，我先等新消息，不重复旧回答。'})
      }
      if (this.director.candidate && result.action.startsWith('reply_')) {
        this.director.candidate.replyStream=result.replyStream
        if(prepared) {
          this.director.candidate.preparedSpeech=prepared.speech
          job.prepared=null
        }
        this.attachOpening(result)
        if(!this.director.candidate.preparedSpeech && result.action==='reply_host' && !snapshot.active)
          this.director.candidate.preparedSpeech=this.prepareSpeech?.({...this.director.candidate,firstSentenceOnly:true})
        this.director.candidate.timings={inputAt:snapshot.hostOpportunity?snapshot.latestHost.endedAt:job.started,decisionStartedAt:job.started,decisionReadyAt:this.now()}
        if(prepared)Object.assign(this.director.candidate.timings,{decisionStartedAt:prepared.startedAt,decisionReadyAt:prepared.readyAt,answerPrepared:true})
        result=undefined // The candidate now owns the stream.
      }
      this.lastKey=viewerOnly?job.key:this.key(this.context())
    } catch (error) {
      if (!this.closed && (!job.controller.signal.aborted || job.timedOut) &&
        this.director.revision===job.revision) {
        const code=job.timedOut?'timeout':error instanceof ParticipationError && Object.hasOwn(errorMessages,error.code)?error.code:'unknown'
        if(snapshot.programOpportunity)this.hosting?.failed(code)
        this.director.record('hold',code==='timeout'?'participation_timeout':'participation_error',
          {explanation:errorMessages[code],errorCode:code})
      }
    } finally {
      job.prepared?.speech?.close()
      result?.replyStream?.close()
      if(job.controller.signal.aborted && snapshot.programOpportunity && this.hosting?.engaged &&
        snapshot.hosting.revision===this.hosting.revision && !this.director.candidate && !this.scheduler.active)this.hosting.wait()
      if(job.thoughtId && this.thought.value?.id===job.thoughtId)this.thought.value.reviewed=true
      if(this.job===job)this.job=null
      if(this.pending){this.pending=false;this.notify()}
    }
  }
  canObserve(snapshot){
    return Boolean(this.observe && !this.job && !this.timer && !snapshot.hostOpportunity && !snapshot.pendingOpportunity && !snapshot.eligibleViewers.length &&
      this.now()-this.lastObservationAt>=this.observationGapMs && this.hosting?.canObserve(this.scheduler))
  }
  async runObservation(snapshot){
    const job={key:this.key(snapshot),controller:new AbortController(),revision:this.director.revision,version:this.scheduler.version,hostingRevision:snapshot.hosting.revision,observation:true}
    this.job=job;this.lastObservationAt=this.now()
    try {
      const task=this.tasks.start({key:'observe:'+job.key,kind:'director-observation',signal:job.controller.signal,timeoutMs:this.timeoutMs,
        run:options=>this.observe(snapshot,options)})
      const outcome=await task.done
      if(outcome.state==='cancelled')return false
      if(outcome.state!=='completed')throw outcome.error??new ParticipationError('timeout')
      if(this.closed || job.controller.signal.aborted || !this.enabled || this.director.mode!=='auto' || this.scheduler.muted || this.scheduler.hostSpeaking ||
        this.scheduler.active || this.director.candidate || this.director.revision!==job.revision || this.scheduler.version!==job.version)return false
      return this.hosting.acceptObservation(outcome.value,job.hostingRevision)
    }catch(error){
      if(!this.closed && !job.controller.signal.aborted && this.hosting.revision===job.hostingRevision){
        const code=error instanceof ParticipationError?error.code:'unknown'
        this.hosting.failed(code)
        this.director.record('hold','participation_error',{explanation:'持续观察暂时失败，先保持安静；连接恢复后再判断。',errorCode:code})
      }
      return false
    }finally {
      if(this.job===job)this.job=null
      if(this.pending){this.pending=false;this.notify()}
    }
  }
  openingInput(text) {
    const u=this.director.utterance
    if(!u || text===null)return text
    let state=this.openingInputState
    if(!state || state.id!==u.id) {
      const prefix=state?.final && this.now()-state.at<15000 ? state.text : ''
      state={id:u.id,prefix,text:'',final:false,at:this.now()}
      this.openingInputState=state
    }
    let combined=state.prefix?state.prefix+'，'+text:text
    if(combined.length>2000){state.prefix='';combined=text}
    if(combined!==state.text)state.at=this.now()
    state.text=combined;state.final=Boolean(u.final)
    return combined
  }
  syncOpeningPreparation() {
    const d=this.director,s=this.scheduler,u=d.utterance,l=d.listening,o=this.openingPreparation
    if(!this.openingPreparationEnabled || this.closed || !this.enabled || !this.plan || d.mode!=='auto' || s.muted ||
      s.active && !s.active.listening || ['stop','backchannel'].includes(d.intent) || !u || u.id===d.consumedUtterance) {o.clear();this.openingInputState=null;return}
    const text=this.openingInput(u.final?u.text:this.preparationText(u,l))
    if(text===null)return
    o.update(text)
    // A VAD boundary ends an ASR segment, not necessarily the human's thought.
    // Keep already-running, still-relevant silent work across that boundary;
    // it owns at most one of the two task slots. No new work starts here and
    // the ordinary final-input decision never waits for an opening to finish.
    if(u.final || this.finishingUtterance===u.id)return
    if(this.now()-l.updatedAt<200 || text.length<12)return
    // VAD-final clauses also delimit unpunctuated streaming ASR. A stable
    // unpunctuated prefix can request a silent opening, but is never a final
    // user turn: the ordinary model still checks the complete input before use.
    const clause=text.match(/^[\s\S]*[，,。！!？?；;]/u)?.[0] ?? text
    if(clause.length<12)return
    const snapshot=this.context()
    Object.assign(snapshot,{hostOpportunity:true,hostSpeaking:true,active:false,activeTurn:null,eligibleViewers:[],
      programOpportunity:false,pendingOpportunity:false,latestHost:{...u,text:clause,final:false,endedAt:null},heardText:text})
    delete snapshot.speaking;delete snapshot.preparedOpenings
    o.start(snapshot)
  }
  attachOpening(result) {
    const c=this.director.candidate,u=this.director.utterance
    if(!c || result.openingId===undefined || c.listening || !u?.final)return
    const opening=this.openingPreparation.take(result.openingId,this.openingInput(u.text),result.text)
    if(!opening)return
    c.preparedSpeech?.close();c.preparedSpeech=opening.speech
    c.openingPreparedAt=opening.at
  }
  async runListening(listening) {
    const d=this.director,s=this.scheduler,u=d.utterance
    const job={controller:new AbortController(),revision:d.revision,started:this.now(),listening,utterance:u.id}
    this.job=job;d.listening.review(listening.text)
    const snapshot={...this.context(),hostOpportunity:false,programOpportunity:false,pendingOpportunity:false,
      eligibleViewers:[],listeningOpportunity:true,proactiveCooldownMs:Math.max(0,d.listeningCooldownMs-(this.now()-d.lastListening)),latestHost:{...u,text:listening.text},listening}
    let result
    try {
      const task=this.tasks.start({key:`listening:${u.id}:${job.started}`,kind:'participation-review',signal:job.controller.signal,
        timeoutMs:this.timeoutMs,run:options=>this.plan(snapshot,options),discard:value=>value?.replyStream?.close()})
      const outcome=await task.done
      if(outcome.state!=='completed')return
      result=outcome.value
      if(this.closed || job.controller.signal.aborted || !this.enabled || d.mode!=='auto' || s.muted || s.active ||
        d.revision!==job.revision || d.utterance?.id!==job.utterance || !d.listening.relevant(listening.text) || d.intent==='stop')return
      // Early speech is one short sentence. Later stream records cannot extend it into a monologue.
      if(result?.action!=='reply_host' || typeof result.text!=='string' || !result.text.trim() || result.text.length>4 ||
        typeof result.reason!=='string' || !result.reason.trim() || result.reason.length>180 ||
        !['invited','spontaneous'].includes(result.hostIntent) || this.now()-d.lastListening<d.listeningCooldownMs)return
      const animation=normalizePerformance(result)
      d.candidate={id:++d.nextDecision,revision:d.revision,listening:true,text:listening.text,intent:'opportunity',
        expiresAt:this.now()+6500,preparedReply:result.text.trim(),speechStyle:result.speechStyle,streaming:true,
        performance:animation.performance,decisionMs:this.now()-job.started,
        timings:{inputAt:job.started,decisionStartedAt:job.started,decisionReadyAt:this.now()}}
      d.candidate.preparedSpeech=this.prepareSpeech?.(d.candidate)
      this.lastDecision={action:'reply_host',reason:result.reason,decisionMs:this.now()-job.started,at:this.now()}
      d.record('hold','listening_ready',{explanation:'我听到这个点了，等一个停顿插一句。'})
    } finally {
      result?.replyStream?.close()
      if(this.job===job)this.job=null
      this.pending=false
      this.notify()
    }
  }
  async runFloor(floor) {
    const d=this.director,s=this.scheduler
    const job={controller:new AbortController(),floor,revision:d.revision}
    this.job=job;this.lastFloorKey=floor.key;this.lastFloorUtterance=floor.utterance;this.nextFloorAt=this.now()+800
    const snapshot={...this.context(),floorOpportunity:true,hostOpportunity:false,programOpportunity:false,
      latestHost:{...d.utterance,text:floor.text},eligibleViewers:[]}
    let result
    try {
      const task=this.tasks.start({key:floor.key,kind:'floor-review',signal:job.controller.signal,timeoutMs:1600,
        run:options=>this.plan(snapshot,options),discard:value=>value?.replyStream?.close()})
      const outcome=await task.done
      if(outcome.state!=='completed')return
      result=outcome.value
      if(this.closed || job.controller.signal.aborted || d.revision!==job.revision ||
        s.active?.id!==floor.turn || d.utterance?.id!==floor.utterance ||
        (d.listening.text!==floor.text && !(result.floorIntent==='backchannel' && acknowledgmentExtension(floor.text,d.listening.text,Boolean(d.utterance.final)))) ||
        !['backchannel','takeover','uncertain'].includes(result.floorIntent))return
      s.active.floorReview={id:this.now(),utterance:floor.utterance,text:floor.text,intent:result.floorIntent}
      if(d.utterance.final) {
        this.lastFloorKey=JSON.stringify([floor.turn,floor.utterance,d.listening.text,true])
        // A final acknowledgment is already handled, just like a normal wait verdict.
        // Other intents still reach the ordinary planner after this bounded review.
        if(result.floorIntent==='backchannel') {
          this.observedUtterance=floor.utterance
          this.hosting?.wait()
          d.record('hold','floor_acknowledgment')
        }
      }
    } finally {
      result?.replyStream?.close()
      if(this.job===job)this.job=null
      this.pending=false;this.notify()
    }
  }
  apply(result,snapshot,decisionMs,{lookup=false}={}) {
    const d=this.director,s=this.scheduler,u=d.utterance
    if (!result || !['wait','reply_host','reply_viewer','reply_followup','reply_program','react','stop'].includes(result.action) ||
      typeof result.reason!=='string' || !result.reason.trim() || result.reason.length>180 ||
      typeof result.text!=='string' || result.text.length>400) throw new Error('Invalid action')
    if(result.action==='wait' && result.yieldToHost===true && snapshot.active)result={...result,action:'stop'}
    // A semantic stop owns only the current host input and the output it observed.
    // An already finished output still permits holding the floor, never cancelling a newer one.
    if(result.action==='stop' && (!snapshot.hostOpportunity || !snapshot.active || !u?.final || u.id!==snapshot.latestHost?.id ||
      u.endedAt===null || this.now()-u.endedAt>=this.opportunityMs ||
      (s.active && s.active.id!==snapshot.activeTurn)))return
    // Only a current, final host request can grant or restore continuous hosting.
    // Viewer messages, silent reviews and speculative listening never own this control.
    if(['start','pause'].includes(result.hostingControl) && this.hosting && snapshot.hostOpportunity && u?.final &&
      u.id===snapshot.latestHost?.id && u.endedAt!==null && this.now()-u.endedAt<this.opportunityMs &&
      snapshot.hosting?.revision===this.hosting.revision &&
      !s.muted && d.mode==='auto' && this.enabled) {
      if(result.hostingControl==='pause' && allowsHostingControl(u.text)) {
        this.hosting.stop()
        s.interrupt('hosting_control')
        this.observedUtterance=u.id;d.consumedUtterance=u.id
        d.record('hold','hosting_changed',{explanation:'自主主持已暂停，等你明确让我继续。'})
        return
      }
      if(result.hostingControl==='start' && allowsHostingStart(u.text) && result.action!=='stop' && !result.yieldToHost) {
        this.hosting.automatic=true
        this.hosting.start(result.hostingTopic??this.hosting.topic)
        snapshot={...snapshot,hosting:this.hosting.context(s)}
        if(s.active)this.hosting.track(s.active)
        d.record('hold','hosting_changed',{explanation:'你把直播交给我了，我会继续主持；需要时直接叫停或加入聊天。'})
      }
    }
    const animation=normalizePerformance(result)
    result={...result,...animation,warnings:[...(result.warnings??[]),...animation.warnings]}
    if (result.warnings.length) d.record('hold','performance_adjusted',{
      explanation:result.warnings.includes('motion_dropped') || result.warnings.includes('performance_dropped') || result.warnings.includes('components_dropped')
        ? '这次动作有一部分不合规，已略过；接话照常。' : result.warnings.includes('thought_dropped') ? '这次便签格式不合规，已略过；原来的决定照常。' : '动作字段的位置已校正，按安全范围执行。',
      performanceWarnings:result.warnings})
    if (snapshot.hostOpportunity && u?.id === snapshot.latestHost?.id) this.observedUtterance=u.id
    if(!result.replyStream && snapshot.hostOpportunity)this.onCoaching(result)
    const details={explanation:result.reason,decisionMs}
    const continuationContext={...snapshot.continuationContext,action:result.action}
    const continuation=this.continuity?.prepare(result.continuation,continuationContext)
    this.lastDecision={action:result.action,reason:result.reason,decisionMs,at:this.now()}
    if(snapshot.pendingThought && (snapshot.hostOpportunity || snapshot.pendingOpportunity)) {
      if(result.action!=='reply_followup')this.thought.take(snapshot.pendingThought.id,this.scene.topic)
    }
    if(['wait','react'].includes(result.action) && result.thought && !continuation && snapshot.hostOpportunity && !snapshot.pendingOpportunity) {
      if(this.thought.set(result.thought,{topic:this.scene.topic,utterance:u.id,active:snapshot.active,activeTurn:snapshot.activeTurn}))
        d.record('hold','participation_deferred',{explanation:'我先记着这个想法：'+this.thought.value.text})
    }
    if(result.action==='wait') {
      if(result.floorIntent==='backchannel' && snapshot.hostOpportunity && s.active?.id===snapshot.activeTurn && u?.id===snapshot.latestHost?.id)
        s.active.floorReview={id:this.now(),utterance:u.id,text:u.text,intent:'backchannel'}
      if(!s.active)this.hosting?.decide(result,snapshot.hosting?.revision)
      else if(snapshot.hostOpportunity)this.hosting?.wait()
      this.continuity?.commit(continuation);d.record('hold','participation_wait',details);return
    }
    if(result.action==='react') {
      if(!snapshot.hostOpportunity || !u || this.now()-u.endedAt>=this.opportunityMs || s.active || result.text.length>40 || (!this.hosting?.engaged && this.now()-d.lastParticipation<d.participationCooldownMs))return
      d.lastParticipation=this.now();d.consumedUtterance=u.id
      this.continuity?.commit(continuation)
      this.hosting?.decide(result,snapshot.hosting?.revision)
      this.onReaction(result)
      d.record('hold','participation_reaction',details);return
    }
    if(result.action==='stop') {
      this.thought.clear()
      d.applyIntent('stop','participation_stop',details);return
    }
    if(!result.text.trim())return
    if(result.action==='reply_program') {
      if(!snapshot.programOpportunity || !this.hosting?.engaged || snapshot.hosting.revision!==this.hosting.revision ||
        snapshot.hostOpportunity || s.active || s.hostSpeaking || result.hostIntent!=='spontaneous')return
      d.candidate={id:++d.nextDecision,revision:d.revision,source:'program',hostingRevision:this.hosting.revision,
        text:this.hosting.topic || '自主选择并推进一个适合文字互动的直播话题',intent:'program',expiresAt:this.now()+1500,
        hostingIntent:result.hostingIntent,hostingTopic:result.hostingTopic,hostingPace:result.hostingPace,revisitAfterSeconds:result.revisitAfterSeconds,preparedReply:result.text,speechStyle:result.speechStyle,sticker:result.sticker,performance:result.performance,motion:result.motion,
        performanceTarget:result.performanceTarget,performanceIssues:result.performanceIssues,decisionMs}
      d.record('reply','hosting_reply',details);return
    }
    if(result.action==='reply_followup') {
      const thought=this.thought.snapshot(this.scene.topic)
      if(!snapshot.pendingOpportunity || !thought || result.thoughtId!==thought.id || thought.id!==snapshot.pendingThought?.id ||
        result.hostIntent!=='spontaneous' || s.active || s.hostSpeaking || !u?.final || u.id!==thought.utterance ||
        this.now()-d.lastParticipation<d.participationCooldownMs) {this.thought.clear();return}
      d.candidate={id:++d.nextDecision,revision:d.revision,text:u.text,intent:'opportunity',thoughtId:thought.id,
        expiresAt:Math.min(this.now()+1500,thought.expiresAt),hostingIntent:result.hostingIntent,hostingTopic:result.hostingTopic,hostingPace:result.hostingPace,revisitAfterSeconds:result.revisitAfterSeconds,preparedReply:result.text,speechStyle:result.speechStyle,sticker:result.sticker,performance:result.performance,motion:result.motion,performanceTarget:result.performanceTarget,performanceIssues:result.performanceIssues,decisionMs}
      d.record('reply','participation_followup',details);return
    }
    if(result.action==='reply_host') {
      if(!snapshot.hostOpportunity || !u?.final || u.endedAt===null || u.id===d.consumedUtterance ||
        u.id!==snapshot.latestHost?.id || this.now()-u.endedAt>=(lookup?directorLookupMs:this.opportunityMs))return
      // Direct questions are not throttled by the proactive budget; the model receives this state.
      if(!this.hosting?.engaged && result.hostIntent !== 'invited' && this.now()-d.lastParticipation<d.participationCooldownMs) {
        d.record('hold','participation_cooldown',{explanation:'我刚补充过一次，这次先让主播继续。'});return
      }
      // An invitation has the same takeover semantics as the director's explicit handover.
      // Spontaneous additions never replace an answer already being spoken.
      if(s.active) { if(result.hostIntent!=='invited')return; s.interrupt('reply_replaced') }
      d.candidate={id:++d.nextDecision,revision:d.revision,text:u.text,intent:result.hostIntent === 'invited' ? 'handover' : 'opportunity',
        expiresAt:this.now()+1500,hostingIntent:result.hostingIntent,hostingTopic:result.hostingTopic,hostingPace:result.hostingPace,revisitAfterSeconds:result.revisitAfterSeconds,preparedReply:result.text,speechStyle:result.speechStyle,sticker:result.sticker,performance:result.performance,motion:result.motion,performanceTarget:result.performanceTarget,performanceIssues:result.performanceIssues,decisionMs,continuation,continuationContext}
    } else {
      if(!(d.viewerWindow || this.hosting?.engaged) || s.active)return
      const item=s.eligibleViewers().find(x=>x.id===result.targetId && x.platform===result.platform)
      if(!item || !snapshot.eligibleViewers.some(x=>x.id===item.id && x.platform===item.platform))return
      d.candidate={id:++d.nextDecision,revision:d.revision,source:'viewer',messageId:item.id,platform:item.platform,
        text:item.text,intent:'viewer',expiresAt:Math.min(this.now()+1500,s.viewerExpiresAt(item)),
        hostingIntent:result.hostingIntent,hostingTopic:result.hostingTopic,hostingPace:result.hostingPace,revisitAfterSeconds:result.revisitAfterSeconds,preparedReply:result.text,speechStyle:result.speechStyle,sticker:result.sticker,performance:result.performance,motion:result.motion,performanceTarget:result.performanceTarget,performanceIssues:result.performanceIssues,decisionMs,semanticSelection:true}
    }
    d.record('reply','participation_reply',details)
  }
  close() {this.closed=true;this.invalidate({clearThought:true});this.tasks.close()}
}
