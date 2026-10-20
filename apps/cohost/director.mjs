import { performance } from 'node:perf_hooks'
import { TaskScope } from './task-scope.mjs'
import { LiveListening } from './live-listening.mjs'
import { isBackchannel } from '../../packages/cohost-contracts/floor.ts'
import { listeningTailMs } from '../../packages/cohost-contracts/listening-tail.ts'

const intents = new Set(['hold', 'handover', 'backchannel', 'takeover', 'stop', 'opportunity'])
// Only complete imperative clauses qualify. Quotes, negation and discussion stay with the planner.
const stopPhrase = /^(?:(?:小鲸鱼|大肥鱼|助播)[，,：:\s]+)?(?:(?:等一下|先听我说|先听我(?:说|讲)完|(?:先)?让我(?:说|讲)完|我还没(?:说|讲)完|等我(?:说|讲)完|我先(?:说|讲)完|先别说了|别说了|停止回答|(?:先|请)?(?:停一下|停一停|打住|停))[。！!，,、；;\s]*){1,12}$/u
const acknowledgment = /^(?:(?:嗯+|哦+|对|是的|没错|好的|好)[。！!，,、\s]*){1,3}$/u
const addressedQuestion = /^(?:助播|小鲸鱼)[，,：:\s].*(你怎么看|你觉得|你来说|你来回答|帮我解释|说说你的看法)/u

function invalid(message) { const error = new Error(message); error.status = 400; throw error }
function string(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid('需要有效文本')
  return value.trim()
}

// Deterministic fast path. A future semantic adapter runs beside generation, never before it.
export class Director {
  constructor({ scheduler, now = Date.now, classify = null, semanticTimeoutMs = 200,
    opportunityMs = 2000, acknowledgmentMs = 800, participationCooldownMs = 15_000, listeningCooldownMs = 3500 } = {}) {
    this.scheduler = scheduler
    this.listening = new LiveListening({now})
    this.now = now
    this.classify = classify
    this.semanticTimeoutMs = semanticTimeoutMs
    this.opportunityMs = opportunityMs
    this.acknowledgmentMs = acknowledgmentMs
    this.participationCooldownMs = participationCooldownMs
    this.lastParticipation = -Infinity
    this.listeningCooldownMs = listeningCooldownMs
    this.lastListening = -Infinity
    this.consumedUtterance = null
    this.mode = 'manual'
    this.revision = 0
    this.utterance = null
    this.utteranceNumber = 0
    this.candidate = null
    this.nextDecision = 0
    this.intent = 'hold'
    this.intentFrom = 'rules'
    this.pendingSemantic = null
    this.semanticJob = null
    this.trace = []
    this.traceNumber = 0
    this.viewerWindow = false
    this.followUp = null
    this.closed=false
    this.tasks=new TaskScope({name:'semantic-adapter',maxRunning:2,maxWaiting:1,now})
  }

  record(action, reason, details = {}) {
    const entry = { ...details, id: ++this.traceNumber, at: this.now(), revision: this.revision, action, reason }
    this.onRecord?.(entry)
    this.trace.push(entry)
    if (this.trace.length > 100) this.trace.shift()
    return entry
  }

  invalidate(reason) {
    this.revision++
    if(this.candidate?.source==='program' && this.candidate.hostingRevision===this.hosting?.revision)this.hosting.wait()
    this.candidate?.replyStream?.close()
    this.candidate?.preparedSpeech?.close()
    this.candidate = null
    this.pendingSemantic = null
    this.semanticJob?.controller.abort()
    this.intent = 'hold'
    this.intentFrom = 'rules'
    this.record('hold', reason)
  }

  reset(reason = 'reset', { clearSpeech = false } = {}) {
    this.listening.reset()
    this.invalidate(reason)
    // Keep the utterance identity so its later speech-end can release the VAD flag.
    this.consumedUtterance = this.utterance?.id ?? null
    if (clearSpeech) {
      this.utterance = null
      this.scheduler.observeHostSpeaking(false)
    }
  }

  event(event) {
    const started = performance.now()
    if (!event || typeof event !== 'object') invalid('需要导演事件')
    switch (event.type) {
      case 'mode':
        this.listening.reset()
        if (!['manual', 'auto'].includes(event.value)) invalid('mode 需要 manual 或 auto')
        if (this.mode !== event.value) this.consumedUtterance = this.utterance?.id ?? null
        this.mode = event.value
        this.invalidate('mode_changed')
        break
      case 'viewer-window':
        if (typeof event.value !== 'boolean') invalid('value 需要布尔值')
        this.viewerWindow = event.value
        this.invalidate('viewer_window_changed')
        break
      case 'speech-start': {
        const id = event.utterance
        if (!Number.isSafeInteger(id) || id <= 0) invalid('utterance 需要递增正整数')
        if (id <= this.utteranceNumber) return this.status()
        this.resumeListening(event)
        this.listening.reset()
        this.utteranceNumber = id
        this.invalidate('host_voice_detected')
        this.utterance = { id, text: '', final: false, startedAt: this.now(), endedAt: null }
        this.scheduler.observeHostSpeaking(true)
        break
      }
      case 'speech-progress': {
        const text=string(event.text)
        if(typeof event.confirmed!=='string' || !text.startsWith(event.confirmed))invalid('无效稳定转写')
        if(!Number.isSafeInteger(event.utterance))invalid('需要 utterance 编号')
        if(!this.utterance || event.utterance!==this.utterance.id || this.utterance.final)return this.status()
        this.listening.update(text,event.confirmed)
        if(this.candidate?.listening && !this.listening.relevant(this.candidate.text))this.invalidate('listening_updated')
        if(this.scheduler.active?.listening && !this.listening.relevant(this.scheduler.active.input.text))this.scheduler.interrupt('listening_updated')
        break
      }
      case 'speech-pause':
        if(!Number.isSafeInteger(event.utterance) || typeof event.paused!=='boolean')invalid('无效停顿事件')
        if(!this.utterance || event.utterance!==this.utterance.id)return this.status()
        this.listening.pause(event.paused)
        if(!event.paused)this.resumeListening(event)
        break
      case 'speech-end':
        if (!Number.isSafeInteger(event.utterance)) invalid('需要 utterance 编号')
        if (!this.utterance || event.utterance !== this.utterance.id || this.utterance.endedAt !== null) return this.status()
        if(!this.utterance.final && this.listening.text) {
          if(this.scheduler.active?.listening)this.scheduler.interrupt('recognition_failed')
          this.listening.reset()
          this.invalidate('recognition_empty')
        }
        this.utterance.endedAt = this.now()
        this.scheduler.observeHostSpeaking(false)
        this.evaluate()
        this.queueSemantic()
        break
      case 'transcript': {
        const text = string(event.text)
        if (typeof event.final !== 'boolean') invalid('final 需要布尔值')
        if (!Number.isSafeInteger(event.utterance)) invalid('需要 utterance 编号')
        if (!this.utterance || event.utterance !== this.utterance.id || this.utterance.final) return this.status()
        if (event.final) this.onTranscript?.({ text, utterance: event.utterance })
        const samePreview=event.final && ((this.candidate?.listening && this.listening.relevant(this.candidate.text,text)) ||
          (this.listening.matches(text) && this.listening.sameContent(this.listening.reviewed,text)))
        if(!samePreview)this.invalidate('transcript_updated')
        if(event.final && this.scheduler.active?.listening && !text.startsWith(this.scheduler.active.listening.text) &&
          !this.listening.sameContent(text,this.scheduler.active.listening.text))this.scheduler.interrupt('listening_updated')
        if(event.final && this.listening.answered && this.listening.sameContent(this.listening.answered,text))this.consumedUtterance=event.utterance
        if(event.final)this.listening.update(text,text)
        this.utterance.text = text
        this.utterance.final = event.final
        this.evaluate()
        this.queueSemantic()
        break
      }
      // Explicit simulated/adapter classification, not a claim of real semantic inference.
      case 'intent':
        if (!intents.has(event.intent) || !Number.isSafeInteger(event.revision) ||
          !Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) invalid('无效的语义判断')
        this.acceptIntent(event, 'adapter')
        break
      case 'topic-change':
        this.viewerWindow = false
        this.reset('topic_changed')
        this.scheduler.queue = []
        if (this.scheduler.active?.input.source === 'viewer') this.scheduler.interrupt()
        break
      case 'interrupt':
        this.listening.reset()
        this.invalidate('explicit_interrupt')
        this.scheduler.interrupt('manual_interrupt')
        break
      default: invalid('未知导演事件')
    }
    this.lastEventMs = performance.now() - started
    return this.status()
  }

  evaluate() {
    const u = this.utterance
    if (!u?.final) return
    if (stopPhrase.test(u.text)) { if(this.intent!=='stop')this.applyIntent('stop', 'exact_stop_phrase'); return }
    if(u.id===this.consumedUtterance)return
    if(this.candidate?.listening)return
    if (this.scheduler.active && isBackchannel(u.text)) {
      this.applyIntent('backchannel', 'spoken_acknowledgment')
      return
    }
    if (acknowledgment.test(u.text)) {
      if (u.text.length <= 12 && u.endedAt !== null && u.endedAt - u.startedAt <= this.acknowledgmentMs)
        this.applyIntent('backchannel', 'short_acknowledgment')
      return
    }
    if (addressedQuestion.test(u.text)) this.applyIntent('handover', 'explicit_address')
    else if (this.intentFrom !== 'rules' && this.intent !== 'hold') this.applyIntent(this.intent, this.intentFrom)
    else this.record('hold', 'needs_semantic_evidence')
  }

  acceptIntent(result, reason) {
    if (result.revision !== this.revision || !this.utterance || this.utterance.id === this.consumedUtterance || this.scheduler.muted ||
      !intents.has(result.intent) || !Number.isFinite(result.confidence) || result.confidence < 0.85 || result.confidence > 1) return false
    // Stop words and explicit handovers cannot be reversed by a late classifier.
    if (this.utterance.final && (stopPhrase.test(this.utterance.text) || addressedQuestion.test(this.utterance.text))) return false
    if (this.utterance.endedAt !== null && this.now() - this.utterance.endedAt > this.opportunityMs) return false
    this.applyIntent(result.intent, reason)
    return true
  }

  applyIntent(intent, reason, details = {}) {
    this.intent = intent
    this.intentFrom = reason
    if (['stop', 'takeover'].includes(intent)) {
      this.listening.reset()
      this.candidate?.replyStream?.close()
      this.candidate = null
      this.consumedUtterance = this.utterance?.id ?? null
      this.scheduler.interrupt(intent === 'stop' ? 'host_stop' : 'host_takeover')
      this.record('stop', reason, {explanation:intent === 'stop' ? '收到叫停，我先保持安静，等你继续。' : '你先说，我停下来听。',...details})
      return
    }
    if (intent === 'handover' && this.scheduler.active) this.scheduler.interrupt('reply_replaced')
    if (intent === 'backchannel' || intent === 'hold') {
      this.candidate?.replyStream?.close()
      this.candidate = null
      this.record('hold', reason)
      return
    }
    const u = this.utterance
    if (intent === 'opportunity' && this.now() - this.lastParticipation < this.participationCooldownMs) return
    if (this.mode !== 'auto' || this.scheduler.muted || this.scheduler.hostSpeaking ||
      this.scheduler.status().busy || !u?.final || u.endedAt === null) return
    if (this.now() - u.endedAt > this.opportunityMs) return
    // With the unified planner, an explicit invitation uses the same one-call
    // answer path as ordinary speech, including MCP lookup and coaching.
    if(this.semanticHost && intent==='handover')return
    if (!this.candidate) this.candidate = { id: ++this.nextDecision, revision: this.revision,
      text: u.text, intent, expiresAt: u.endedAt + this.opportunityMs }
    this.record('reply', reason)
  }

  consume(id) {
    this.scheduler.expirePlayback()
    const candidate = this.candidate
    if (!candidate || candidate.id !== id) return null
    // Keep an early answer ready, but never claim the floor from raw ASR alone.
    if(candidate.listening && this.now()<candidate.expiresAt &&
      (!this.canSpeakListening(candidate.text) || (candidate.preparedSpeech && !candidate.preparedSpeech.ready && !candidate.preparedSpeech.playable && !candidate.preparedSpeech.failed)))return null
    this.candidate = null
    const reject = () => {
      candidate.replyStream?.close()
      candidate.preparedSpeech?.close()
      if(candidate.source==='program' && candidate.hostingRevision===this.hosting?.revision)this.hosting.wait()
      return null
    }
    const attach = turn => {
      if (!turn) return reject()
      Object.assign(turn, {hostingIntent:candidate.hostingIntent,hostingTopic:candidate.hostingTopic,hostingPace:candidate.hostingPace,revisitAfterSeconds:candidate.revisitAfterSeconds,preparedReply:candidate.preparedReply,speechStyle:candidate.speechStyle,replyStream:candidate.replyStream,sticker:candidate.sticker,performance:candidate.performance,motion:candidate.motion,performanceTarget:candidate.performanceTarget,performanceIssues:candidate.performanceIssues,decisionMs:candidate.decisionMs,timings:candidate.timings,continuation:candidate.continuation,continuationContext:candidate.continuationContext})
      if (turn.replyStream) turn.controller.signal.addEventListener('abort',()=>turn.replyStream.close(),{once:true})
      turn.preparedSpeech=candidate.preparedSpeech
      if(turn.preparedSpeech) {
        turn.timings={...turn.timings,ttsPreparedAt:turn.preparedSpeech.startedAt,preparedFirstPcmAt:turn.preparedSpeech.firstPcmAt}
        turn.controller.signal.addEventListener('abort',()=>turn.preparedSpeech.close(),{once:true})
      }
      return turn
    }
    if (candidate.revision !== this.revision ||
      this.now() >= candidate.expiresAt || this.mode !== 'auto' || this.scheduler.muted ||
      (this.scheduler.hostSpeaking && !candidate.listening) || this.scheduler.active || candidate.preparedSpeech?.failed) return reject()
    if(candidate.listening) {
      if(!this.canSpeakListening(candidate.text))return reject()
      this.listening.answered=candidate.text
      if(this.utterance.final && this.listening.sameContent(candidate.text,this.utterance.text))this.consumedUtterance=this.utterance.id
      const previousListening=this.lastListening
      const participatedAt=this.now()
      this.lastListening=participatedAt
      this.invalidate('decision_consumed')
      const turn=this.scheduler.begin({source:'host',text:candidate.text,participation:'listening'})
      turn.listening={utterance:this.utterance.id,text:candidate.text}
      turn.canStart=()=>this.canSpeakListening(candidate.text)
      turn.controller.signal.addEventListener('abort',()=>{
        if(turn.playedChars || turn.playback==='playing')return
        if(this.utterance?.id===turn.listening.utterance && this.listening.answered===candidate.text) {
          this.listening.answered=''
          if(this.consumedUtterance===turn.listening.utterance)this.consumedUtterance=null
        }
        if(this.lastListening===participatedAt)this.lastListening=previousListening
      },{once:true})
      return attach(turn)
    }
    if(candidate.thoughtId!==undefined && !this.followUp?.validate(candidate.thoughtId))return reject()
    if (candidate.source === 'program') {
      if(!this.hosting?.engaged || candidate.hostingRevision!==this.hosting.revision)return reject()
      this.invalidate('decision_consumed')
      return attach(this.scheduler.begin({source:'program',text:candidate.text}))
    }
    if (candidate.source === 'viewer') {
      const item = candidate.semanticSelection ? this.scheduler.eligibleViewers().find(x => x.id === candidate.messageId && x.platform === candidate.platform) : this.scheduler.peekViewer()
      if (!(this.viewerWindow || this.hosting?.engaged) || !item || item.id !== candidate.messageId || item.platform !== candidate.platform) return reject()
      this.invalidate('viewer_decision_consumed')
      const turn = this.scheduler.beginViewer(item)
      return attach(turn)
    }
    this.consumedUtterance = this.utterance.id
    if (candidate.intent === 'opportunity') this.lastParticipation = this.now()
    this.invalidate('decision_consumed')
    const turn = this.scheduler.beginHost(candidate.text)
    if (turn) {
      if(candidate.thoughtId!==undefined){this.followUp.consume(candidate.thoughtId);turn.input.source='followup'}
      turn.input.participation = candidate.intent
    }
    return attach(turn)
  }

  queueSemantic() {
    if (this.closed || !this.classify || this.mode !== 'auto' || this.scheduler.muted || !this.utterance?.text ||
      stopPhrase.test(this.utterance.text) || addressedQuestion.test(this.utterance.text)) return
    this.pendingSemantic = { revision: this.revision, utterance: { ...this.utterance },
      playing: this.scheduler.active?.playback === 'playing' }
    this.pumpSemantic()
  }

  pumpSemantic() {
    if (this.closed || this.semanticJob || !this.pendingSemantic) return
    const snapshot = this.pendingSemantic
    this.pendingSemantic = null
    const job = { controller: new AbortController() }
    this.semanticJob = job
    // Adapter must be asynchronous I/O or a worker, never synchronous model inference.
    const task=this.tasks.start({key:String(snapshot.revision),kind:'semantic-review',signal:job.controller.signal,
      timeoutMs:this.semanticTimeoutMs,run:options=>this.classify(snapshot,options)})
    void task.done.then(outcome=>{
      if(this.closed || job.controller.signal.aborted || snapshot.revision!==this.revision)return
      if(outcome.state==='completed' && outcome.value)this.acceptIntent({...outcome.value,revision:snapshot.revision},'semantic')
      if(outcome.state==='failed')this.record('hold',outcome.reason==='timeout'?'semantic_timeout':'semantic_unavailable')
    }).catch(()=>{if(!this.closed && !job.controller.signal.aborted)this.record('hold','semantic_unavailable')})
      .finally(() => {
        if(this.semanticJob===job)this.semanticJob = null
        this.pumpSemantic()
      })
  }

  close() { this.closed=true;this.candidate?.replyStream?.close();this.candidate?.preparedSpeech?.close();this.candidate=null;this.pendingSemantic=null;this.semanticJob?.controller.abort();this.tasks.close() }

  canSpeakListening(text) {
    return this.listening.relevant(text) && (this.listening.quiet || Boolean(this.utterance?.final && this.utterance.endedAt!==null))
  }

  resumeListening(event) {
    const turn=this.scheduler.active
    if(!turn?.listening)return
    // A lease is tied to this audio and never renewed by later VAD frames.
    if(turn.listeningTailUntil!==undefined) {
      if(this.now()>=turn.listeningTailUntil)this.scheduler.interrupt('host_resumed')
      return
    }
    const tail=event.listeningTail
    const ms=tail?.turn===turn.id && tail.audioId===turn.audioId && turn.playback==='playing' && turn.preparedSpeech?.ready
      ? listeningTailMs(turn.preparedSpeech.durationMs,tail.remainingMs) : 0
    // The renderer stops at the measured end. Leave the rest of the same
    // 180 ms cap for its ordered completion receipt to reach this process.
    if(ms)turn.listeningTailUntil=this.now()+180
    else this.scheduler.interrupt('host_resumed')
  }

  canContinueListening() {
    const turn=this.scheduler.active
    return Boolean(turn?.listening && (turn.listeningTailUntil!==undefined
      ? this.now()<turn.listeningTailUntil : this.canSpeakListening(turn.listening.text)))
  }

  proposeViewer() {
    if (this.semanticViewer || !this.viewerWindow || this.mode !== 'auto' || this.candidate) return
    const item = this.scheduler.peekViewer()
    if (!item) return
    this.candidate = { id: ++this.nextDecision, revision: this.revision, source: 'viewer',
      messageId: item.id, platform: item.platform, text: item.text, intent: 'viewer',
      expiresAt: Math.min(this.now() + this.opportunityMs, item.receivedAt + this.scheduler.ttlMs) }
    this.record('reply', 'viewer_window_open')
  }

  status() {
    if (this.candidate && this.now() >= this.candidate.expiresAt) { this.candidate.replyStream?.close();this.candidate.preparedSpeech?.close(); this.candidate = null }
    this.proposeViewer()
    return { viewerWindow: this.viewerWindow, trace: [...this.trace], mode: this.mode, revision: this.revision, utterance: this.utterance?.id ?? null,
        intent: this.intent, candidate: this.candidate ? { ...this.candidate, replyStream:undefined,preparedSpeech:undefined,audioReady:this.candidate.preparedSpeech?.ready } : null,
      lastDecision: this.trace.at(-1) ?? null, lastEventMs: this.lastEventMs ?? 0,
      semanticBusy: Boolean(this.semanticJob), semanticPending: Boolean(this.pendingSemantic) }
  }
}
