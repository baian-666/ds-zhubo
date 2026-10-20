import type { createSpeechPipeline, IntentHandle, TtsRequest } from '@proj-airi/pipelines-audio'

import { toWav } from '@proj-airi/audio/encoding'
import { onMounted, onUnmounted, shallowRef } from 'vue'

import * as v from 'valibot'

import workletUrl from '../workers/vad/process.worklet?worker&url'

import { useVAD } from '../stores/ai/models/vad'
import { useHearingStore } from '../stores/modules/hearing'
import { useSettingsAudioDevice } from '../stores/settings/audio-device'
import { useAudioDevice } from './audio/audio-device'
import { observePerformance } from './cohost-media-state'
import { listeningTailMs } from './listening-tail'
import { RecognitionTurns } from './recognition-turns'
import { SpeechFloor } from './speech-floor'
import { SpeechPause } from './speech-pause'
import { StreamingRecognition } from './streaming-recognition'

type InputPhase = 'off' | 'starting' | 'listening' | 'speaking' | 'recognizing' | 'empty' | 'short' | 'error'
interface InputStatus { phase: InputPhase, level: number, device: string, issue: string, quiet: boolean, partial?: string }
/** Renderer-local capture feedback. No audio or provider credential enters this UI state. */
export const cohostInput = shallowRef<InputStatus>({ phase: 'off', level: 0, device: '', issue: '', quiet: false })

const pulseSchema = v.object({
  run: v.nullable(v.string()),
  capture: v.optional(v.boolean(), false),
  captureRevision: v.optional(v.number(), 0),
  recognition: v.optional(v.picklist(['siliconflow', 'dashscope', 'local']), 'siliconflow'),
  turn: v.optional(v.nullable(v.object({
    id: v.number(),
    audioId: v.string(),
    text: v.string(),
    done: v.boolean(),
    listening: v.boolean(),
    speechBoundaries: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
    floorReview: v.nullable(v.object({ id: v.number(), utterance: v.number(), text: v.string(), intent: v.picklist(['backchannel', 'takeover', 'uncertain']) })),
  }))),
})
type Turn = NonNullable<v.InferOutput<typeof pulseSchema>['turn']>
const speechFrameSchema = v.variant('type', [
  v.object({ type: v.literal('audio'), sampleRate: v.picklist([22050, 24000]), pcm: v.pipe(v.string(), v.maxLength(2_000_000), v.regex(/^[A-Z0-9+/]+={0,2}$/i)) }),
  v.object({ type: v.literal('done') }),
  v.object({ type: v.literal('ready') }),
  v.object({ type: v.literal('error') }),
])
type Pipeline = ReturnType<typeof createSpeechPipeline<AudioBuffer>>

/**
 * One lease binds microphone input and speech playback to the cohost director.
 * The stage keeps no provider credentials or durable provider settings.
 */
class CohostVoice {
  private readonly origin = 'http://127.0.0.1:8787'
  private readonly hearing = useHearingStore()
  private readonly device = useAudioDevice()
  private readonly audioSettings = useSettingsAudioDevice()
  private readonly vad
  private run: string | null = null
  private captureRevision = 0
  private captureRequested = false
  private captureQueue = Promise.resolve()
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
  private readonly speechPause = new SpeechPause()
  private readonly endpointSilence = shallowRef(320)
  private listeningAudio: { turnId: string | undefined, durationMs: number, elapsed: () => number } | undefined
  private listeningTailUntil: number | undefined
  private listeningTailTimer: ReturnType<typeof setTimeout> | undefined
  private readonly floor = new SpeechFloor()
  private floorState: 'play' | 'hold' | 'yield' = 'play'
  private lastFloorReview = 0
  private lastSegmentAt = 0
  private lastSegmentText = ''
  private readonly floorListeners = new Set<(paused: boolean) => void>()
  private recognitionQueue = Promise.resolve()
  private readonly recognitions = new Set<AbortController>()
  private recognitionProvider: 'siliconflow' | 'dashscope' | 'local' = 'siliconflow'
  private readonly streamingSegments = new Map<number, StreamingRecognition>()
  private readonly failedStreaming = new Set<number>()
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

  constructor(private readonly audioContext: AudioContext, private readonly ready: () => boolean, private readonly stage: 'web' | 'desktop', private readonly owner: string) {
    this.vad = useVAD(workletUrl, {
      minSilenceDurationMs: this.endpointSilence,
      silenceThreshold: 0.003,
      onSpeechStart: () => {
        if (!this.run || !this.captureRequested)
          return
        this.speechPause.reset()
        this.endpointSilence.value = this.turn && !this.turn.listening ? 650 : 320
        this.floor.reset(this.floorState === 'hold')
        if (this.turn?.listening)
          this.resumeListening()
        this.utterance = Math.max(Date.now(), this.utterance + 1)
        if (!this.input.begin(this.utterance)) {
          cohostInput.value = { ...cohostInput.value, phase: 'error', issue: 'backlog' }
          this.captureFailed('backlog')
          return
        }
        cohostInput.value = { ...cohostInput.value, phase: 'speaking', issue: '', partial: '' }
        this.postEvent({ type: 'speech-start', utterance: this.utterance })
        if (this.recognitionProvider !== 'siliconflow')
          this.startStreamingRecognition()
      },
      onSpeechAudio: ({ buffer, speech }) => {
        this.streamingSegments.get(this.utterance)?.push(buffer)
        // VAD evaluates 512-sample frames; its first ASR buffer also contains old padding.
        // Only the current frame counts toward a pause or a sustained takeover.
        const frame = buffer.subarray(-512)
        const audible = this.speechPause.audible(speech, frame)
        if (this.captureRequested && this.turn) {
          if (audible && this.turn.listening)
            this.resumeListening()
          else if (!this.turn.listening)
            this.applyFloor(this.floor.observe(audible, frame.length))
        }
        if (!this.captureRequested || this.recognitionProvider === 'siliconflow')
          return
        const paused = this.speechPause.observe(audible, frame.length)
        if (paused !== undefined && this.utterance > 0)
          this.postEvent({ type: 'speech-pause', utterance: this.utterance, paused })
      },
      onSpeechCancel: () => {
        this.endpointSilence.value = this.turn && !this.turn.listening ? 650 : 320
        this.streamingSegments.get(this.utterance)?.cancel()
        this.streamingSegments.delete(this.utterance)
        this.failedStreaming.delete(this.utterance)
        this.finishRecognition(this.utterance, '', 'short')
      },
      onSpeechReady: ({ buffer }) => {
        this.endpointSilence.value = this.turn && !this.turn.listening ? 650 : 320
        if (!this.captureRequested)
          return
        const run = this.run
        const revision = this.captureRevision
        const utterance = this.utterance
        cohostInput.value = { ...cohostInput.value, phase: 'recognizing' }
        if (this.recognitionProvider !== 'siliconflow') {
          if (this.failedStreaming.delete(utterance))
            this.finishRecognition(utterance, '', 'error')
          else
            this.streamingSegments.get(utterance)?.end()
          return
        }
        // Short pauses keep earlier ASR alive. Stop/reconnect still cancels the whole lease.
        this.recognitionQueue = this.recognitionQueue.then(async () => {
          if (run && this.run === run && this.captureRequested && this.captureRevision === revision)
            await this.transcribe(buffer, run, utterance, revision)
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
    if (this.turn?.listening && this.listeningTailUntil !== undefined
      && (body.type === 'speech-start' || (body.type === 'speech-pause' && body.paused === false))) {
      body = { ...body, listeningTail: { turn: this.turn.id, audioId: this.turn.audioId, remainingMs: Math.max(0, this.listeningTailUntil - Date.now()) } }
    }
    const payload = ['speech-start', 'speech-end', 'speech-pause', 'transcript', 'capture-error', 'floor'].includes(String(body.type))
      ? { ...body, captureRevision: this.captureRevision }
      : body
    // Ordered receipts prevent a later segment from acknowledging an earlier one.
    this.feedback = this.feedback.then(async () => {
      if (this.run !== run)
        return
      const response = await fetch(`${this.origin}/api/airi/stage/event`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
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
    pipeline.on('onSentencePlaybackEnd', (item) => {
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
      clearTimeout(this.listeningTailTimer)
      if (this.started && !this.turn.text.slice(this.played).trim()) {
        this.played = this.turn.text.length
        this.receipt('ended')
        observePerformance(clock => clock.end(this.turn!.audioId))
      }
      else {
        this.receipt('error')
        observePerformance(clock => clock.end(this.turn!.audioId, true))
      }
    })
  }

  /** Accepts playback only while this lease and its server turn remain current. */
  async beforePlay(turnId: string | undefined, signal: AbortSignal) {
    if (!this.run || !this.turn || turnId !== this.intent?.turnId || signal.aborted)
      return false
    if (this.turn.listening && this.vad.isSpeech.value && !this.speechPause.quiet())
      return false
    if (this.started)
      return true
    const run = this.run
    const turn = this.turn
    if (this.floorState === 'hold') {
      await new Promise<void>((resolve) => {
        const resume = (paused: boolean) => {
          if (paused && !signal.aborted)
            return
          this.floorListeners.delete(resume)
          signal.removeEventListener('abort', abort)
          resolve()
        }
        function abort() {
          resume(false)
        }
        this.floorListeners.add(resume)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    await this.feedback
    if (signal.aborted || this.run !== run || this.turn?.id !== turn.id)
      return false
    try {
      const response = await fetch(`${this.origin}/api/airi/stage/event`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ type: 'playback', turn: this.turn.id, audioId: this.turn.audioId, event: 'started', playedChars: 0 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      })
      const body = v.parse(v.object({ accepted: v.boolean() }), await response.json())
      if (this.run !== run || this.turn?.id !== turn.id)
        return false
      if (!body.accepted || signal.aborted) {
        this.receipt('error')
        this.cancelTurn()
        return false
      }
      this.started = true
      return true
    }
    catch {
      if (this.run !== run || this.turn?.id !== turn.id)
        return false
      this.receipt('error')
      this.cancelTurn()
      return false
    }
  }

  /** Records a software playback receipt. It does not measure the physical speaker. */
  scheduled(turnId: string | undefined) {
    if (this.turn && turnId === this.intent?.turnId)
      this.postEvent({ type: 'timing', point: 'playback-scheduled', turn: this.turn.id, audioId: this.turn.audioId })
  }

  playbackKey(turnId: string | undefined) {
    return turnId === this.intent?.turnId ? this.turn?.audioId : undefined
  }

  private cancelTurn() {
    clearTimeout(this.listeningTailTimer)
    this.listeningTailUntil = undefined
    this.listeningAudio = undefined
    // Keep the longer window through an in-flight acknowledgment segment.
    if (!this.vad.isSpeech.value)
      this.endpointSilence.value = 320
    this.floor.reset()
    const intent = this.intent
    if (this.turn)
      this.lastClosedTurn = Math.max(this.lastClosedTurn, this.turn.id)
    if (this.turn)
      observePerformance(clock => clock.end(this.turn!.audioId, true))
    this.intent = undefined
    intent?.cancel('cohost cancelled')
    this.turn = undefined
    this.floorState = 'play'
    this.lastFloorReview = 0
    for (const listener of this.floorListeners)
      listener(false)
    this.written = 0
    this.played = 0
    this.started = false
    this.ended = false
  }

  private yieldTurn() {
    this.receipt('stopped')
    this.cancelTurn()
  }

  trackListeningAudio(turnId: string | undefined, durationMs: number, elapsed: () => number) {
    const audio = { turnId, durationMs, elapsed }
    if (this.turn?.listening && turnId === this.intent?.turnId)
      this.listeningAudio = audio
    return () => {
      if (this.listeningAudio === audio)
        this.listeningAudio = undefined
    }
  }

  private resumeListening() {
    if (this.turn?.done && this.played === this.turn.text.length)
      return
    if (this.listeningTailUntil !== undefined) {
      if (Date.now() >= this.listeningTailUntil)
        this.yieldTurn()
      return
    }
    const audio = this.listeningAudio
    const remaining = audio && audio.turnId === this.intent?.turnId
      ? listeningTailMs(audio.durationMs, audio.durationMs - audio.elapsed())
      : 0
    if (!remaining) {
      this.yieldTurn()
      return
    }
    this.listeningTailUntil = Date.now() + remaining
    const turnId = this.turn?.id
    const intentId = this.intent?.intentId
    this.listeningTailTimer = setTimeout(() => {
      if (this.turn?.id === turnId && this.intent?.intentId === intentId)
        this.yieldTurn()
    }, Math.min(180, remaining + 16))
  }

  /** The active audio source pauses locally. The shared context keeps recording. */
  watchFloor(listener: (paused: boolean) => void) {
    this.floorListeners.add(listener)
    listener(this.floorState === 'hold')
    return () => this.floorListeners.delete(listener)
  }

  playingSegment(turnId: string | undefined, text: string, offsetMs: number) {
    if (!this.turn || turnId !== this.intent?.turnId)
      return
    if (text === this.lastSegmentText && Date.now() - this.lastSegmentAt < 400)
      return
    this.lastSegmentText = text
    this.lastSegmentAt = Date.now()
    this.postEvent({ type: 'playing-segment', turn: this.turn.id, audioId: this.turn.audioId, text, offsetMs })
  }

  private applyFloor(state: 'play' | 'hold' | 'yield') {
    if (!this.turn || this.turn.listening || state === this.floorState)
      return
    this.floorState = state
    this.postEvent({ type: 'floor', turn: this.turn.id, audioId: this.turn.audioId, utterance: this.utterance, state })
    if (state === 'yield') {
      this.yieldTurn()
      return
    }
    for (const listener of this.floorListeners)
      listener(state === 'hold')
  }

  /** Cancels playback and synthesis before releasing the capture device. */
  stop() {
    this.run = null
    this.captureRequested = false
    this.stopCapture()
    for (const request of this.requests)
      request.abort()
    this.cancelTurn()
  }

  private stopCapture() {
    if (this.floorState === 'hold')
      this.yieldTurn()
    this.floor.reset()
    this.speechPause.reset()
    for (const segment of this.streamingSegments.values())
      segment.cancel()
    this.streamingSegments.clear()
    this.failedStreaming.clear()
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
    this.vad.dispose()
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = undefined
    this.device.stopStream()
  }

  private captureFailed(issue: string) {
    if (!this.captureRequested)
      return
    this.postEvent({ type: 'capture-error' })
    this.stopCapture()
    cohostInput.value = { ...cohostInput.value, phase: 'error', issue }
  }

  private async capture(run: string, revision: number) {
    const current = () => this.run === run && this.captureRequested && this.captureRevision === revision
    try {
      if (!current())
        return
      cohostInput.value = { ...cohostInput.value, phase: 'starting' }
      await this.audioContext.resume()
      if (this.recognitionProvider !== 'siliconflow') {
        const controller = new AbortController()
        this.recognitions.add(controller)
        try {
          const response = await fetch(`${this.origin}/api/airi/stage/recognition/prepare`, {
            method: 'POST',
            headers: { ...this.headers(), 'X-Cohost-Capture': String(revision) },
            body: '{}',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          })
          if (!response.ok)
            throw new Error('Recognition connection unavailable')
          await response.json()
        }
        catch {
          if (current())
            this.captureFailed('recognition')
          return
        }
        finally { this.recognitions.delete(controller) }
        if (!current())
          return
      }
      await this.vad.init()
      if (!current()) {
        this.vad.dispose()
        return
      }
      if (!this.vad.loaded.value)
        throw new Error('VAD unavailable')
      this.device.selectedAudioInput.value = this.audioSettings.selectedAudioInput || 'default'
      const stream = await this.device.startStream()
      if (!stream)
        throw new Error('Microphone unavailable')
      if (!current()) {
        stream.getTracks().forEach(track => track.stop())
        this.device.stopStream()
        this.vad.dispose()
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
      if (!current())
        this.stopCapture()
    }
    catch {
      if (current())
        this.captureFailed('device')
    }
  }

  private finishRecognition(utterance: number, text: string, phase: InputPhase = 'empty') {
    if (!this.captureRequested)
      return
    const result = this.input.complete(utterance, text)
    if (!result)
      return
    this.applyFloor(this.floor.transcript(result.text, true))
    if (result.text)
      this.postEvent({ type: 'transcript', utterance: result.utterance, text: result.text, final: true })
    this.postEvent({ type: 'speech-end', utterance: result.utterance })
    cohostInput.value = { ...cohostInput.value, phase: result.text ? 'listening' : phase, partial: '' }
  }

  private startStreamingRecognition() {
    const run = this.run
    const revision = this.captureRevision
    const utterance = this.utterance
    const current = () => this.run === run && this.captureRequested && this.captureRevision === revision
    const segment = new StreamingRecognition(this.origin, { ...this.headers(), 'X-Cohost-Capture': String(revision) }, utterance, (text) => {
      if (current() && utterance === this.utterance) {
        cohostInput.value = { ...cohostInput.value, partial: text }
        this.applyFloor(this.floor.transcript(text))
      }
    }, (text) => {
      this.streamingSegments.delete(utterance)
      if (current())
        this.finishRecognition(utterance, text)
    }, () => {
      this.streamingSegments.delete(utterance)
      if (current()) {
        cohostInput.value = { ...cohostInput.value, issue: 'recognition' }
        // A transport error cannot declare silence while the microphone still detects speech.
        if (utterance === this.utterance && this.vad.isSpeech.value)
          this.failedStreaming.add(utterance)
        else
          this.finishRecognition(utterance, '', 'error')
      }
    })
    this.streamingSegments.set(utterance, segment)
  }

  private async transcribe(buffer: Float32Array, run: string, utterance: number, revision: number) {
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
        headers: { 'X-Cohost-Capture': String(revision) },
      }),
    }
    try {
      const file = new File([toWav(buffer.slice().buffer, 16000)], 'recording.wav', { type: 'audio/wav' })
      const result = await this.hearing.transcription('openai-compatible-audio-transcription', provider, 'FunAudioLLM/SenseVoiceSmall', file, 'json')
      const text = result.mode === 'generate' ? result.text : await result.text
      if (this.run !== run || controller.signal.aborted || !this.captureRequested || this.captureRevision !== revision)
        return
      this.finishRecognition(utterance, text)
    }
    catch {
      if (this.run === run && !controller.signal.aborted && this.captureRequested && this.captureRevision === revision) {
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
    if (this.vad.inferenceError.value) {
      this.captureFailed('detection')
      return
    }
    if (this.stream?.getAudioTracks()[0]?.readyState === 'ended') {
      this.captureFailed('device')
      return
    }
    this.analyser.getFloatTimeDomainData(this.samples)
    const rms = Math.sqrt(this.samples.reduce((sum, amount) => sum + amount * amount, 0) / this.samples.length)
    if (rms > 0.003)
      this.lastSound = Date.now()
    const level = rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)) : 0
    cohostInput.value = { ...cohostInput.value, level, quiet: Date.now() - this.lastSound > 5000 }
  }

  /** Uses AIRI chunking and playback with fixed-provider audio from the local server. */
  async* synthesizeStream(request: TtsRequest, signal: AbortSignal): AsyncGenerator<AudioBuffer> {
    if (!this.run || request.turnId !== this.intent?.turnId || !this.turn)
      return
    const run = this.run
    const turn = this.turn.id
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    this.requests.add(controller)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      if (signal.aborted)
        return
      const response = await fetch(`${this.origin}/api/airi/stage/audio/speech`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ turn, input: request.text }),
        signal: controller.signal,
      })
      if (!response.ok)
        throw new Error('Speech request failed')
      if (response.headers.get('Content-Type')?.startsWith('audio/wav')) {
        // The existing non-streaming provider still uses AIRI's whole-audio path.
        const audio = await response.arrayBuffer()
        if (!signal.aborted && this.run === run && this.turn?.id === turn)
          yield await this.audioContext.decodeAudioData(audio)
        return
      }
      if (!response.body || !response.headers.get('Content-Type')?.startsWith('application/x-ndjson'))
        throw new Error('Invalid speech transport')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let complete = false
      let bytes = 0
      while (true) {
        const frame = await reader.read()
        if (signal.aborted || this.run !== run || this.turn?.id !== turn)
          return
        if (frame.done)
          break
        pending += decoder.decode(frame.value, { stream: true })
        if (pending.length > 2_000_000)
          throw new Error('Speech frame too large')
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          const value = v.parse(speechFrameSchema, JSON.parse(pending.slice(0, end)))
          pending = pending.slice(end + 1)
          if (value.type === 'error')
            throw new Error('Speech synthesis failed')
          if (value.type === 'done') {
            if (complete || !bytes)
              throw new Error('Invalid speech completion')
            complete = true
          }
          else if (value.type === 'audio') {
            if (complete)
              throw new Error('Invalid PCM frame')
            const pcm = Uint8Array.from(atob(value.pcm), char => char.charCodeAt(0))
            bytes += pcm.length
            if (!pcm.length || pcm.length % 2 || bytes > 6_000_000)
              throw new Error('Invalid PCM size')
            const audio = this.audioContext.createBuffer(1, pcm.length / 2, value.sampleRate)
            const samples = audio.getChannelData(0)
            const view = new DataView(pcm.buffer)
            for (let index = 0; index < samples.length; index++)
              samples[index] = view.getInt16(index * 2, true) / 32768
            yield audio
          }
        }
      }
      if (!complete || pending.trim())
        throw new Error('Speech ended before completion')
    }
    catch {
      if (!signal.aborted && this.run === run && this.turn?.id === turn) {
        this.receipt('error')
        this.cancelTurn()
        throw new Error('Cohost speech failed')
      }
    }
    finally {
      signal.removeEventListener('abort', abort)
      controller.abort()
      this.requests.delete(controller)
      await reader?.cancel().catch(() => {})
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
      observePerformance(clock => clock.begin(turn.audioId))
      this.intent = this.pipeline?.openIntent({ turnId: `cohost:${this.run}:${turn.id}`, ownerId: this.owner, behavior: 'replace', wholeUtterance: turn.listening })
    }
    this.turn = turn
    if (!turn.listening)
      this.endpointSilence.value = 650
    if (turn.floorReview && turn.floorReview.id !== this.lastFloorReview && turn.floorReview.utterance === this.utterance) {
      this.lastFloorReview = turn.floorReview.id
      this.applyFloor(this.floor.review(turn.floorReview.text, turn.floorReview.intent))
      if (!this.turn)
        return
    }
    if (turn.text.length > this.written) {
      for (const boundary of turn.speechBoundaries) {
        if (boundary > this.written && boundary <= turn.text.length) {
          this.intent?.writeLiteral(turn.text.slice(this.written, boundary))
          this.intent?.writeFlush()
          this.written = boundary
        }
      }
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
    if (this.turn && this.captureRequested)
      this.applyFloor(this.floor.action())
    this.pollRequest = new AbortController()
    const timeout = setTimeout(() => this.pollRequest?.abort(), 1000)
    try {
      const response = await fetch(`${this.origin}/api/airi/stage/pulse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: this.stage, owner: this.owner, ready: !!this.pipeline && this.ready(), listening: !!this.stream && this.vad.loaded.value, captureRevision: this.captureRevision }),
        signal: this.pollRequest.signal,
      })
      if (!response.ok) {
        if (Date.now() - this.lastPulse > 2500)
          this.stop()
        return
      }
      const state = v.parse(pulseSchema, await response.json())
      if (this.disposed)
        return
      this.lastPulse = Date.now()
      if (state.run !== this.run) {
        this.stop()
        this.run = state.run
        this.lastClosedTurn = 0
        if (state.run)
          void this.audioContext.resume().catch(() => {})
      }
      if (state.run && (state.capture !== this.captureRequested || state.captureRevision !== this.captureRevision)) {
        this.stopCapture()
        this.captureRequested = state.capture
        this.captureRevision = state.captureRevision
        this.recognitionProvider = state.recognition
        if (state.capture) {
          const run = state.run
          const revision = state.captureRevision
          // Serialize device initialization so a late start cannot replace a newer stream.
          this.captureQueue = this.captureQueue.catch(() => {}).then(() => this.capture(run, revision))
        }
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
      if (this.captureRequested || this.turn || Date.now() - this.lastPulse >= 150)
        void this.poll()
    }, 50)
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

/** The application root owns this lease. Route changes leave it running. */
export function useCohostVoice(audioContext: AudioContext, ready: () => boolean, stage: 'web' | 'desktop', owner: string) {
  const bridge = new CohostVoice(audioContext, ready, stage, owner)
  onMounted(() => bridge.mount())
  const close = () => bridge.dispose()
  window.addEventListener('pagehide', close)
  onUnmounted(() => {
    window.removeEventListener('pagehide', close)
    bridge.dispose()
  })
  return bridge
}
