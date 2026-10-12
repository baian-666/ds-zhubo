import type { createSpeechPipeline, IntentHandle, TtsRequest } from '@proj-airi/pipelines-audio'

import { toWav } from '@proj-airi/audio/encoding'
import { onMounted, onUnmounted, shallowRef } from 'vue'

import * as v from 'valibot'

import workletUrl from '../workers/vad/process.worklet?worker&url'

import { useVAD } from '../stores/ai/models/vad'
import { useHearingStore } from '../stores/modules/hearing'
import { useAudioDevice } from './audio/audio-device'
import { RecognitionTurns } from './recognition-turns'

type InputPhase = 'off' | 'starting' | 'listening' | 'speaking' | 'recognizing' | 'empty' | 'short' | 'error'
interface InputStatus { phase: InputPhase, level: number, device: string, issue: string, quiet: boolean }
/** Renderer-local capture feedback. No audio or provider credential enters this UI state. */
export const cohostInput = shallowRef<InputStatus>({ phase: 'off', level: 0, device: '', issue: '', quiet: false })

const pulseSchema = v.object({
  run: v.nullable(v.string()),
  turn: v.optional(v.nullable(v.object({
    id: v.number(),
    audioId: v.string(),
    text: v.string(),
    done: v.boolean(),
  }))),
})
type Turn = NonNullable<v.InferOutput<typeof pulseSchema>['turn']>
type Pipeline = ReturnType<typeof createSpeechPipeline<AudioBuffer>>

/**
 * One lease binds microphone input and speech playback to the cohost director.
 * The stage keeps no provider credentials or durable provider settings.
 */
class CohostVoice {
  private readonly owner = crypto.randomUUID()
  private readonly origin = 'http://127.0.0.1:8787'
  private readonly stage = location.port === '5174' ? 'desktop' : 'web'
  private readonly hearing = useHearingStore()
  private readonly device = useAudioDevice()
  private readonly vad
  private run: string | null = null
  private stream: MediaStream | undefined
  private pipeline: Pipeline | undefined
  private intent: IntentHandle | undefined
  private turn: Turn | undefined
  private lastClosedTurn = 0
  private written = 0
  private played = 0
  private started = false
  private ended = false
  private utterance = 0
  private readonly input = new RecognitionTurns()
  private recognitionQueue = Promise.resolve()
  private readonly recognitions = new Set<AbortController>()
  private analyser: AnalyserNode | undefined
  private inputSource: MediaStreamAudioSourceNode | undefined
  private samples = new Float32Array(1024)
  private lastSound = 0
  private pollRequest: AbortController | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private lastPulse = Date.now()
  private polling = false
  private disposed = false
  private feedback = Promise.resolve()
  private readonly requests = new Set<AbortController>()

  constructor(private readonly audioContext: AudioContext, private readonly ready: () => boolean) {
    this.vad = useVAD(workletUrl, {
      minSilenceDurationMs: 650,
      onSpeechStart: () => {
        if (!this.run)
          return
        this.utterance = Math.max(Date.now(), this.utterance + 1)
        if (!this.input.begin(this.utterance)) {
          cohostInput.value = { ...cohostInput.value, phase: 'error', issue: 'backlog' }
          this.postEvent({ type: 'error' })
          return
        }
        cohostInput.value = { ...cohostInput.value, phase: 'speaking', issue: '' }
        this.postEvent({ type: 'speech-start', utterance: this.utterance })
      },
      onSpeechCancel: () => {
        this.finishRecognition(this.utterance, '', 'short')
      },
      onSpeechReady: ({ buffer }) => {
        const run = this.run
        const utterance = this.utterance
        cohostInput.value = { ...cohostInput.value, phase: 'recognizing' }
        // Short pauses keep earlier ASR alive. Stop/reconnect still cancels the whole lease.
        this.recognitionQueue = this.recognitionQueue.then(async () => {
          if (run && this.run === run)
            await this.transcribe(buffer, run, utterance)
        })
      },
    })
  }

  private headers() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.run}:${this.owner}` }
  }

  private postEvent(body: Record<string, unknown>) {
    const run = this.run
    if (!run)
      return
    const headers = this.headers()
    // Ordered receipts prevent a later segment from acknowledging an earlier one.
    this.feedback = this.feedback.then(async () => {
      if (this.run !== run)
        return
      const response = await fetch(`${this.origin}/api/airi/stage/event`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      })
      if (!response.ok)
        throw new Error('Voice feedback failed')
    }).catch(() => {
      if (this.run === run)
        cohostInput.value = { ...cohostInput.value, issue: 'connection' }
    })
  }

  private receipt(event: string) {
    if (!this.turn)
      return
    this.postEvent({ type: 'playback', turn: this.turn.id, audioId: this.turn.audioId, event, playedChars: this.played })
  }

  bind(pipeline: Pipeline) {
    this.pipeline = pipeline
    pipeline.on('onPlaybackEnd', ({ item }) => {
      if (item.turnId !== this.intent?.turnId || !this.turn)
        return
      const at = this.turn.text.indexOf(item.text, this.played)
      if (at < 0 || this.turn.text.slice(this.played, at).trim()) {
        this.receipt('error')
        this.cancelTurn()
        return
      }
      this.played = at + item.text.length
      this.receipt('progress')
    })
    pipeline.on('onPlaybackInterrupt', ({ item }) => {
      if (item.turnId === this.intent?.turnId) {
        this.receipt('stopped')
        this.cancelTurn()
      }
    })
    pipeline.on('onPlaybackReject', ({ item }) => {
      if (item.turnId === this.intent?.turnId) {
        this.receipt('error')
        this.cancelTurn()
      }
    })
    pipeline.on('onTurnEnd', (turnId) => {
      if (turnId !== this.intent?.turnId || !this.turn)
        return
      if (this.started && !this.turn.text.slice(this.played).trim()) {
        this.played = this.turn.text.length
        this.receipt('ended')
      }
      else {
        this.receipt('error')
      }
    })
  }

  /** Accepts playback only while this lease and its server turn remain current. */
  async beforePlay(turnId: string | undefined, signal: AbortSignal) {
    if (!this.run || !this.turn || turnId !== this.intent?.turnId || signal.aborted)
      return false
    if (this.started)
      return true
    await this.feedback
    try {
      const response = await fetch(`${this.origin}/api/airi/stage/event`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ type: 'playback', turn: this.turn.id, audioId: this.turn.audioId, event: 'started', playedChars: 0 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      })
      const body = v.parse(v.object({ accepted: v.boolean() }), await response.json())
      if (!body.accepted || signal.aborted) {
        this.receipt('error')
        this.cancelTurn()
        return false
      }
      this.started = true
      return true
    }
    catch {
      this.receipt('error')
      this.cancelTurn()
      return false
    }
  }

  private cancelTurn() {
    const intent = this.intent
    if (this.turn)
      this.lastClosedTurn = Math.max(this.lastClosedTurn, this.turn.id)
    this.intent = undefined
    intent?.cancel('cohost cancelled')
    this.turn = undefined
    this.written = 0
    this.played = 0
    this.started = false
    this.ended = false
  }

  /** Cancels playback and synthesis before releasing the capture device. */
  stop() {
    this.run = null
    for (const request of this.recognitions)
      request.abort()
    this.recognitions.clear()
    this.recognitionQueue = Promise.resolve()
    this.input.reset()
    this.inputSource?.disconnect()
    this.analyser?.disconnect()
    this.inputSource = undefined
    this.analyser = undefined
    cohostInput.value = { phase: 'off', level: 0, device: '', issue: '', quiet: false }
    for (const request of this.requests)
      request.abort()
    this.cancelTurn()
    this.vad.dispose()
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = undefined
    this.device.stopStream()
  }

  private async capture(run: string) {
    try {
      cohostInput.value = { ...cohostInput.value, phase: 'starting' }
      await this.audioContext.resume()
      await this.vad.init()
      if (this.run !== run)
        return
      if (!this.vad.loaded.value)
        throw new Error('VAD unavailable')
      const stream = await this.device.startStream()
      if (!stream)
        throw new Error('Microphone unavailable')
      if (this.run !== run) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      this.stream = stream
      this.inputSource = this.audioContext.createMediaStreamSource(stream)
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = this.samples.length
      this.inputSource.connect(this.analyser)
      this.lastSound = Date.now()
      cohostInput.value = { phase: 'listening', level: 0, device: stream.getAudioTracks()[0]?.label ?? '', issue: '', quiet: false }
      await this.vad.start(stream)
    }
    catch {
      if (this.run === run) {
        this.postEvent({ type: 'error' })
        await this.feedback
        this.stop()
      }
    }
  }

  private finishRecognition(utterance: number, text: string, phase: InputPhase = 'empty') {
    const result = this.input.complete(utterance, text)
    if (!result)
      return
    if (result.text)
      this.postEvent({ type: 'transcript', utterance: result.utterance, text: result.text, final: true })
    this.postEvent({ type: 'speech-end', utterance: result.utterance })
    cohostInput.value = { ...cohostInput.value, phase: result.text ? 'listening' : phase }
  }

  private async transcribe(buffer: Float32Array, run: string, utterance: number) {
    if (buffer.length > 16000 * 55) {
      this.finishRecognition(utterance, '', 'error')
      return
    }
    const controller = new AbortController()
    this.recognitions.add(controller)
    const provider = {
      transcription: (model: string) => ({
        baseURL: `${this.origin}/api/airi/stage/`,
        apiKey: `${run}:${this.owner}`,
        model,
        abortSignal: controller.signal,
      }),
    }
    try {
      const file = new File([toWav(buffer.slice().buffer, 16000)], 'recording.wav', { type: 'audio/wav' })
      const result = await this.hearing.transcription('openai-compatible-audio-transcription', provider, 'FunAudioLLM/SenseVoiceSmall', file, 'json')
      const text = result.mode === 'generate' ? result.text : await result.text
      if (this.run !== run || controller.signal.aborted)
        return
      this.finishRecognition(utterance, text)
    }
    catch {
      if (this.run === run && !controller.signal.aborted) {
        cohostInput.value = { ...cohostInput.value, issue: 'recognition' }
        this.finishRecognition(utterance, '', 'error')
      }
    }
    finally {
      this.recognitions.delete(controller)
    }
  }

  private sampleInput() {
    if (!this.analyser)
      return
    if (this.vad.inferenceError.value)
      cohostInput.value = { ...cohostInput.value, phase: 'error', issue: 'detection' }
    else if (this.stream?.getAudioTracks()[0]?.readyState === 'ended')
      cohostInput.value = { ...cohostInput.value, phase: 'error', issue: 'device' }
    this.analyser.getFloatTimeDomainData(this.samples)
    const rms = Math.sqrt(this.samples.reduce((sum, amount) => sum + amount * amount, 0) / this.samples.length)
    if (rms > 0.003)
      this.lastSound = Date.now()
    const level = rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)) : 0
    cohostInput.value = { ...cohostInput.value, level, quiet: Date.now() - this.lastSound > 5000 }
  }

  /** Uses AIRI chunking and playback with fixed-provider audio from the local server. */
  async synthesize(request: TtsRequest, signal: AbortSignal): Promise<AudioBuffer | null> {
    if (!this.run || request.turnId !== this.intent?.turnId || !this.turn)
      return null
    const run = this.run
    const turn = this.turn.id
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    this.requests.add(controller)
    try {
      if (signal.aborted)
        return null
      const response = await fetch(`${this.origin}/api/airi/stage/audio/speech`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ turn, input: request.text }),
        signal: controller.signal,
      })
      if (!response.ok)
        throw new Error('Speech request failed')
      const audio = await response.arrayBuffer()
      if (signal.aborted || this.run !== run || this.turn?.id !== turn)
        return null
      return await this.audioContext.decodeAudioData(audio)
    }
    catch {
      if (!signal.aborted && this.run === run && this.turn?.id === turn) {
        this.receipt('error')
        this.cancelTurn()
      }
      return null
    }
    finally {
      signal.removeEventListener('abort', abort)
      this.requests.delete(controller)
    }
  }

  private applyTurn(turn: Turn | null | undefined) {
    if (!turn) {
      this.cancelTurn()
      return
    }
    if (turn.id <= this.lastClosedTurn)
      return
    if (turn.id !== this.turn?.id) {
      this.cancelTurn()
      this.turn = turn
      this.intent = this.pipeline?.openIntent({ turnId: `cohost:${this.run}:${turn.id}`, ownerId: this.owner, behavior: 'replace' })
    }
    this.turn = turn
    if (turn.text.length > this.written) {
      this.intent?.writeLiteral(turn.text.slice(this.written))
      this.written = turn.text.length
    }
    if (turn.done && !this.ended) {
      this.ended = true
      this.intent?.end()
    }
  }

  private async poll() {
    if (this.disposed || this.polling)
      return
    this.polling = true
    this.sampleInput()
    this.pollRequest = new AbortController()
    const timeout = setTimeout(() => this.pollRequest?.abort(), 1000)
    try {
      const response = await fetch(`${this.origin}/api/airi/stage/pulse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: this.stage, owner: this.owner, ready: !!this.pipeline && this.ready(), listening: !!this.stream && this.vad.loaded.value }),
        signal: this.pollRequest.signal,
      })
      if (!response.ok) {
        if (Date.now() - this.lastPulse > 2500)
          this.stop()
        return
      }
      const state = v.parse(pulseSchema, await response.json())
      this.lastPulse = Date.now()
      if (state.run !== this.run) {
        this.stop()
        this.run = state.run
        this.lastClosedTurn = 0
        if (state.run)
          void this.capture(state.run)
      }
      if (this.run)
        this.applyTurn(state.turn)
    }
    catch {
      if (Date.now() - this.lastPulse > 2500)
        this.stop()
    }
    finally {
      clearTimeout(timeout)
      this.polling = false
    }
  }

  mount() {
    this.timer = setInterval(() => {
      void this.poll()
    }, 150)
    void this.poll()
  }

  dispose() {
    if (this.run) {
      void fetch(`${this.origin}/api/airi/stage/event`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ type: 'stopped' }),
        keepalive: true,
      }).catch(() => {})
    }
    this.disposed = true
    clearInterval(this.timer)
    this.pollRequest?.abort()
    this.stop()
  }
}

/** Binds the voice lease to the main stage lifecycle. */
export function useCohostVoice(audioContext: AudioContext, ready: () => boolean) {
  const bridge = new CohostVoice(audioContext, ready)
  onMounted(() => bridge.mount())
  onUnmounted(() => bridge.dispose())
  return bridge
}
