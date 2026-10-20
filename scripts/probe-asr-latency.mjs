import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { FunAsrSegment } from '../apps/cohost/fun-asr.mjs'

// Provider-only diagnostic, not a turn-taking acceptance test. Extract original
// PCM without resampling, changing speed, or supplying any expected transcript.
const label = process.argv[2]
if (!/^[a-z0-9-]+$/u.test(label ?? '')) throw Error('Provide a unique diagnostic label')
const output = `data/${label}.json`
if (existsSync(output)) throw Error('Preserve previous diagnostics')
function input(name, choose) {
  const file = `data/listening-audio-trial/${name}.wav`, wav = readFileSync(file)
  let pcm
  for (let at = 12; at + 8 < wav.length;) {
    const length = wav.readUInt32LE(at + 4)
    if (wav.toString('ascii', at, at + 4) === 'data') pcm = wav.subarray(at + 8, at + 8 + length)
    at += 8 + length + length % 2
  }
  if (!pcm) throw Error('Missing PCM')
  const spans = []
  for (let at = 0; at + 320 <= pcm.length; at += 320) {
    let energy = 0
    for (let i = at; i < at + 320; i += 2) energy += (pcm.readInt16LE(i) / 32767) ** 2
    if (Math.sqrt(energy / 160) <= 0.004) continue
    const ms = at / 32
    if (spans.length && ms - spans.at(-1).end < 2000) spans.at(-1).end = ms + 10
    else spans.push({ start: ms, end: ms + 10 })
  }
  const range = choose(spans), start = Math.max(0, range.start - 320), end = Math.min(pcm.length / 32, range.end + 650)
  return { name, file, sha256: createHash('sha256').update(wav).digest('hex'), start, end, voiceEnd: range.end - start,
    pcm: pcm.subarray(Math.round(start * 32), Math.round(end * 32)) }
}
const inputs = [input('backchannel-input', spans => spans[1]), input('input', spans => ({ start: spans.at(-1).end - 6000, end: spans.at(-1).end }))]
const candidates = process.argv.includes('--qwen3') ? [{ name: 'qwen3-manual', model: 'qwen3-asr-flash-realtime' }] : [{ name: 'fun-default', model: 'fun-asr-realtime' },
  { name: 'fun-zh', model: 'fun-asr-realtime', parameters: { language_hints: ['zh'] } },
  { name: 'paraformer-zh', model: 'paraformer-realtime-v2', parameters: { language_hints: ['zh'], disfluency_removal_enabled: false } }]
const report = { kind: 'Original PCM excerpts streamed in real time to cloud ASR; no LLM, TTS or turn-taking acceptance.', calls: [] }
for (const candidate of candidates) for (const audio of inputs) {
  const call = { candidate: candidate.name, input: audio.name, file: audio.file, sha256: audio.sha256, start: audio.start, end: audio.end, events: [], transport: [] }
  report.calls.push(call)
  class Observed extends WebSocket {
    constructor(url, options) {
      super(url, options)
      this.addEventListener('open', () => call.transport.push({ at: Date.now(), event: 'socket-open' }))
      this.addEventListener('error', () => call.transport.push({ at: Date.now(), event: 'socket-error' }))
    }
    send(value) {
      if (typeof value === 'string') {
        const event = JSON.parse(value)
        if (event.header.action === 'run-task') Object.assign(event.payload.parameters, candidate.parameters)
        call.transport.push({ at: Date.now(), event: event.header.action })
        return super.send(JSON.stringify(event))
      }
      return super.send(value)
    }
  }
  call.openedAt = Date.now()
  const emit = event => call.events.push({ at: Date.now(), ...event })
  const task = candidate.model.startsWith('qwen3') ? qwen3(emit) : new FunAsrSegment({ model: candidate.model, finishHedgeMs: 0, WebSocketImpl: Observed, emit })
  try {
    await task.ready
    call.startedAt = Date.now(); call.voiceEndAt = call.startedAt + audio.voiceEnd
    const started = performance.now()
    let sequence = 0
    for (let at = 0; at < audio.pcm.length; at += 1024) {
      task.write(audio.pcm.subarray(at, at + 1024), sequence++)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, started + Math.min(at + 1024, audio.pcm.length) / 32 - performance.now())))
    }
    call.finishedAt = Date.now()
    call.result = await task.finish(sequence)
    call.completedAt = Date.now()
  } catch (error) { call.error = { status: error.status, code: error.providerCode, message: error.message }; process.exitCode = 1 }
  finally { task.close(); writeFileSync(output, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify({ candidate: candidate.name, input: audio.name, error: call.error, finalAfterVoiceMs: call.completedAt - call.voiceEndAt,
    transcript: call.result?.text, partials: call.events.filter(e => e.type === 'partial' && e.text).map(e => ({ ms: e.at - call.startedAt, text: e.text })) }))
}

function qwen3(emit) {
  let resolveReady, rejectReady, resolveDone, rejectDone, text = '', closed = false
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject }), done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  ready.catch(() => {}); done.catch(() => {})
  const socket = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime', { headers: { Authorization: 'Bearer ' + process.env.DASHSCOPE_API_KEY, 'OpenAI-Beta': 'realtime=v1' } })
  const send = value => socket.send(JSON.stringify({ event_id: crypto.randomUUID(), ...value }))
  const close = () => { closed = true; clearTimeout(timer); socket.close() }
  const fail = () => { const error = new Error('Qwen3 diagnostic transport failed'); rejectReady(error); rejectDone(error); close() }
  const timer = setTimeout(fail, 30000)
  socket.addEventListener('error', fail)
  socket.addEventListener('close', () => { if (!closed) fail() })
  socket.addEventListener('open', () => send({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, input_audio_transcription: { language: 'zh' }, turn_detection: null } }))
  socket.addEventListener('message', event => {
    try {
      const value = JSON.parse(String(event.data))
      if (value.type === 'error' || value.type.endsWith('.failed')) return fail()
      if (value.type === 'session.updated') resolveReady()
      if (value.type === 'conversation.item.input_audio_transcription.text') emit({ type: 'partial', text: (value.text ?? '') + (value.stash ?? '') })
      if (value.type === 'conversation.item.input_audio_transcription.completed') { text = value.transcript; emit({ type: 'partial', text, confirmed: text }) }
      if (value.type === 'session.finished') { resolveDone({ text }); close() }
    } catch { fail() }
  })
  return { ready, close, write: pcm => send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }),
    finish: () => { send({ type: 'input_audio_buffer.commit' }); send({ type: 'session.finish' }); return done } }
}
