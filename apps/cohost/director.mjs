import { performance } from 'node:perf_hooks'

const intents = new Set(['hold', 'handover', 'backchannel', 'takeover', 'stop', 'opportunity'])
const stopPhrase = /^(等一下|先听我说|先别说了|停一下|停止回答)[。！!，,\s]*$/u
const acknowledgment = /^(?:(?:嗯+|哦+|对|是的|没错|好的|好)[。！!，,、\s]*){1,3}$/u
const addressedQuestion = /^助播[，,：:\s].*(你怎么看|你觉得|你来说|你来回答|帮我解释|说说你的看法)/u

function invalid(message) { const error = new Error(message); error.status = 400; throw error }
function string(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid('需要有效文本')
  return value.trim()
}

// Deterministic fast path. A future semantic adapter runs beside generation, never before it.
export class Director {
  constructor({ scheduler, now = Date.now, classify = null, semanticTimeoutMs = 200,
    opportunityMs = 2000, acknowledgmentMs = 800, participationCooldownMs = 15_000 } = {}) {
    this.scheduler = scheduler
    this.now = now
    this.classify = classify
    this.semanticTimeoutMs = semanticTimeoutMs
    this.opportunityMs = opportunityMs
    this.acknowledgmentMs = acknowledgmentMs
    this.participationCooldownMs = participationCooldownMs
    this.lastParticipation = -Infinity
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
  }

  record(action, reason) {
    const entry = { at: this.now(), revision: this.revision, action, reason }
    this.trace.push(entry)
    if (this.trace.length > 100) this.trace.shift()
    return entry
  }

  invalidate(reason) {
    this.revision++
    this.candidate = null
    this.pendingSemantic = null
    this.semanticJob?.controller.abort()
    this.intent = 'hold'
    this.intentFrom = 'rules'
    this.record('hold', reason)
  }

  reset(reason = 'reset', { clearSpeech = false } = {}) {
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
        if (!['manual', 'auto'].includes(event.value)) invalid('mode 需要 manual 或 auto')
        this.mode = event.value
        this.invalidate('mode_changed')
        break
      case 'speech-start': {
        const id = event.utterance
        if (!Number.isSafeInteger(id) || id <= 0) invalid('utterance 需要递增正整数')
        if (id <= this.utteranceNumber) return this.status()
        this.utteranceNumber = id
        this.invalidate('host_voice_detected')
        this.utterance = { id, text: '', final: false, startedAt: this.now(), endedAt: null }
        this.scheduler.observeHostSpeaking(true)
        break
      }
      case 'speech-end':
        if (!Number.isSafeInteger(event.utterance)) invalid('需要 utterance 编号')
        if (!this.utterance || event.utterance !== this.utterance.id || this.utterance.endedAt !== null) return this.status()
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
        this.invalidate('transcript_updated')
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
        this.reset('topic_changed')
        this.scheduler.queue = []
        if (this.scheduler.active?.input.source === 'viewer') this.scheduler.interrupt()
        break
      case 'interrupt':
        this.invalidate('explicit_interrupt')
        this.scheduler.interrupt()
        break
      default: invalid('未知导演事件')
    }
    this.lastEventMs = performance.now() - started
    return this.status()
  }

  evaluate() {
    const u = this.utterance
    if (!u?.final || u.id === this.consumedUtterance) return
    if (stopPhrase.test(u.text)) { this.applyIntent('stop', 'exact_stop_phrase'); return }
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

  applyIntent(intent, reason) {
    this.intent = intent
    this.intentFrom = reason
    if (['stop', 'takeover'].includes(intent)) {
      this.candidate = null
      this.scheduler.interrupt()
      this.record('stop', reason)
      return
    }
    if (intent === 'handover' && this.scheduler.active) this.scheduler.interrupt()
    if (intent === 'backchannel' || intent === 'hold') {
      this.candidate = null
      this.record('hold', reason)
      return
    }
    const u = this.utterance
    if (intent === 'opportunity' && this.now() - this.lastParticipation < this.participationCooldownMs) return
    if (this.mode !== 'auto' || this.scheduler.muted || this.scheduler.hostSpeaking ||
      this.scheduler.status().busy || !u?.final || u.endedAt === null) return
    if (this.now() - u.endedAt > this.opportunityMs) return
    if (!this.candidate) this.candidate = { id: ++this.nextDecision, revision: this.revision,
      text: u.text, intent, expiresAt: u.endedAt + this.opportunityMs }
    this.record('reply', reason)
  }

  consume(id) {
    this.scheduler.expirePlayback()
    const candidate = this.candidate
    this.candidate = null
    if (!candidate || candidate.id !== id || candidate.revision !== this.revision ||
      this.now() >= candidate.expiresAt || this.mode !== 'auto' || this.scheduler.muted ||
      this.scheduler.hostSpeaking || this.scheduler.active) return null
    this.consumedUtterance = this.utterance.id
    if (candidate.intent === 'opportunity') this.lastParticipation = this.now()
    this.invalidate('decision_consumed')
    const turn = this.scheduler.beginHost(candidate.text)
    if (turn) turn.input.participation = candidate.intent
    return turn
  }

  queueSemantic() {
    if (!this.classify || this.mode !== 'auto' || this.scheduler.muted || !this.utterance?.text ||
      stopPhrase.test(this.utterance.text) || addressedQuestion.test(this.utterance.text)) return
    this.pendingSemantic = { revision: this.revision, utterance: { ...this.utterance },
      playing: this.scheduler.active?.playback === 'playing' }
    this.pumpSemantic()
  }

  pumpSemantic() {
    if (this.semanticJob || !this.pendingSemantic) return
    const snapshot = this.pendingSemantic
    this.pendingSemantic = null
    const job = { controller: new AbortController(), expired: false }
    this.semanticJob = job
    const timer = setTimeout(() => {
      job.expired = true
      job.controller.abort()
      this.record('hold', 'semantic_timeout')
    }, this.semanticTimeoutMs)
    timer.unref?.()
    // Adapter must be asynchronous I/O or a worker, never synchronous model inference.
    Promise.resolve().then(() => this.classify(snapshot, { signal: job.controller.signal }))
      .then(result => {
        if (!job.expired && !job.controller.signal.aborted && result)
          this.acceptIntent({ ...result, revision: snapshot.revision }, 'semantic')
      }).catch(() => this.record('hold', 'semantic_unavailable'))
      .finally(() => {
        clearTimeout(timer)
        this.semanticJob = null
        this.pumpSemantic()
      })
  }

  close() { this.pendingSemantic = null; this.semanticJob?.controller.abort() }

  status() {
    if (this.candidate && this.now() >= this.candidate.expiresAt) this.candidate = null
    return { mode: this.mode, revision: this.revision, utterance: this.utterance?.id ?? null,
      intent: this.intent, candidate: this.candidate ? { ...this.candidate } : null,
      lastDecision: this.trace.at(-1) ?? null, lastEventMs: this.lastEventMs ?? 0,
      semanticBusy: Boolean(this.semanticJob), semanticPending: Boolean(this.pendingSemantic) }
  }
}
