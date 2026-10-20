import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createApp } from '../apps/cohost/server.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'
import { AUDIO_MODEL, streamQwenAudio } from './qwen-audio-client.mjs'
import { streamQwen } from './qwen-realtime-client.mjs'
import { LocalStreamingAsr } from '../apps/cohost/local-streaming-asr.mjs'

// Waveform-driven experiment: the application owns VAD, ASR, decisions and playback.
// No transcript, speech event, reply or provider audio is injected by this harness.
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { chromium } = playwright.default ?? playwright
const dir = resolve('data/listening-audio-trial')
mkdirSync(dir, { recursive: true })
const fixture = resolve(process.argv.find(arg => arg.startsWith('--input='))?.slice(8) || dir + '/input.wav')
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'baseline'
const pageUrl = process.env.AIRI_TRIAL_URL || 'http://127.0.0.1:5173/?cohost'
if (!/^[a-z0-9-]+$/u.test(label)) throw Error('Use a lowercase trial label')
if (existsSync(dir + '/' + label + '.json')) throw Error('Choose a new label to preserve earlier evidence')
const wav = readFileSync(fixture)
let duration = 0
for (let i = 12; i + 8 < wav.length;) {
  const length = wav.readUInt32LE(i + 4)
  if (wav.toString('ascii', i, i + 4) === 'data') duration = length / 32000
  i += 8 + length + length % 2
}
if (!duration) throw Error('Expected 16 kHz mono PCM input')
const liveHeaders = process.env.COHOST_ACCESS_TOKEN ? { Authorization: 'Bearer ' + process.env.COHOST_ACCESS_TOKEN } : {}
const liveRead = path => fetch('http://127.0.0.1:8787/api/' + path, { headers: liveHeaders }).then(r => r.json())
const [liveSpeech, characters, liveBefore] = await Promise.all([liveRead('speech/config'), liveRead('characters'), liveRead('status')])
const scheduler = new Scheduler()
const director = new Director({ scheduler })
// Diagnostic comparison only: suppress speculative opportunities so the same real WAV
// reaches the ordinary final-transcript reply path. Providers and VAD remain real.
const ordinaryOnly = process.argv.includes('--ordinary-only')
const answerPreparationEnabled = process.argv.includes('--answer-preparation') && !process.argv.includes('--no-answer-preparation')
const openingPreparationEnabled = !process.argv.includes('--no-opening-preparation')
const tailMs=Number(process.argv.find(arg=>arg.startsWith('--tail-ms='))?.slice(10)??3000)
if(!Number.isFinite(tailMs) || tailMs<3000 || tailMs>30000)throw Error('Invalid recording tail')
// Diagnostic override only; never changes the user's saved recognition setting.
const asrModel=process.argv.find(arg=>arg.startsWith('--asr-model='))?.slice(12) || 'fun-asr-realtime'
const localAsr=process.argv.includes('--local-asr') ? new LocalStreamingAsr({python:process.env.LOCAL_ASR_PYTHON || 'D:/work/code/anaconda/python.exe',
  runtimeDir:resolve('data/asr-local/runtime'),modelDir:resolve('data/asr-local/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01')}) : null
if(!['fun-asr-realtime','paraformer-realtime-v2','qwen-audio-3.0-asr-flash-streaming'].includes(asrModel))throw Error('Unsupported trial ASR model')
if (ordinaryOnly) director.listening.offer = () => null
const modelCalls=[]
const speechTrace=[]
async function observedQwen(options) {
  const trace={at:Date.now(),validateOnly:Boolean(options.validateOnly),text:options.text,events:[]}
  let samples=0
  speechTrace.push(trace)
  try {
    const result=await (options.model===AUDIO_MODEL?streamQwenAudio:streamQwen)({...options,onEvent:event=>{
      const {pcm,...metadata}=event
      const receivedAt=Date.now(),audio=pcm?Buffer.from(pcm,'base64'):null
      // Measure provider padding separately from transport and renderer latency.
      // This observes the original PCM without trimming or delaying its delivery.
      if(audio && event.sampleRate) {
        const rate=event.sampleRate,window=Math.round(rate*0.01)
        for(let i=0;i<audio.length/2 && !trace.audibleOnset;i+=window) {
          let sum=0
          for(let j=i;j<Math.min(audio.length/2,i+window);j++) {
            const sample=audio.readInt16LE(j*2)
            if(!trace.signalOnset && Math.abs(sample)>=32)trace.signalOnset={receivedAt,pcmMs:(samples+j)*1000/rate}
            sum+=(sample/32767)**2
          }
          if(Math.sqrt(sum/window)>0.004)trace.audibleOnset={receivedAt,pcmMs:(samples+i)*1000/rate}
        }
        samples+=audio.length/2
      }
      trace.events.push({at:receivedAt,...metadata,...(audio?{bytes:audio.length}:{})})
      options.onEvent?.(event)
    }})
    trace.completedAt=Date.now();trace.result=result
    return result
  }catch(error){trace.failedAt=Date.now();throw error}
}
// Observe the real ASR transport. Do not change audio, provider events or their order.
const recognitionTrace=[]
class ObservedAsrSocket extends WebSocket {
  constructor(url,options) {
    super(url,options)
    this.addEventListener('message',event=>{
      try {
        const value=JSON.parse(String(event.data)),sentence=value.payload?.output?.sentence
        if(recognitionTrace.length<10000)recognitionTrace.push({at:Date.now(),direction:'received',task:value.header?.task_id,event:value.header?.event,
          ...(sentence?{begin:sentence.begin_time,end:sentence.end_time,text:sentence.text,sentenceEnd:sentence.sentence_end}: {})})
      }catch{}
    })
  }
  send(value) {
    if(recognitionTrace.length<10000) {
      if(typeof value==='string') {
        const message=JSON.parse(value)
        this.trialTask=message.header?.task_id
        recognitionTrace.push({at:Date.now(),direction:'sent',task:this.trialTask,event:message.header?.action})
      } else recognitionTrace.push({at:Date.now(),direction:'sent',task:this.trialTask,bytes:value.byteLength})
    }
    return super.send(value)
  }
}
const server = createApp({ token: '', scheduler, director, semanticEnabled: true, rehearsal: true,
  participationOptions:{answerPreparationEnabled,openingPreparationEnabled,endOfSpeechPreparationEnabled:!process.argv.includes('--no-end-preparation')},
  airiOptions:{...(localAsr?{localRecognitionAdapter:localAsr}:{}),realtimeOptions:{WebSocketImpl:ObservedAsrSocket,model:asrModel,onMetric:event=>recognitionTrace.push({direction:'diagnostic',...event})}},
  planner:async(snapshot,options)=>{
    const call={at:Date.now(),listening:Boolean(snapshot.listeningOpportunity),floor:Boolean(snapshot.floorOpportunity),openingPreparation:Boolean(snapshot.openingPreparation),preparedOpenings:snapshot.preparedOpenings,answerPreparation:Boolean(snapshot.answerPreparation),endOfSpeechPreparation:Boolean(snapshot.endOfSpeechPreparation),heard:snapshot.listening,host:snapshot.latestHost?.text}
    modelCalls.push(call)
    try {
      call.metrics={}
      const value=await streamParticipation(snapshot,{...options,metrics:call.metrics,fetchImpl:async(...args)=>{
        const response=await fetch(...args)
        ;(call.providerResponses??=[]).push({at:Date.now(),status:response.status})
        return response
      }})
      Object.assign(call,{finishedAt:Date.now(),action:value.action,text:value.text,reason:value.reason,floorIntent:value.floorIntent,openingId:value.openingId,currentText:director.listening.text})
      if(value.replyStream) {
        const iterate=value.replyStream[Symbol.asyncIterator].bind(value.replyStream)
        value.replyStream[Symbol.asyncIterator]=async function*() {
          call.records=[]
          try {for await(const record of iterate()){call.records.push({kind:record.kind,chars:record.text?.length});yield record}}
          catch(error){call.streamError=error.code??error.name;call.streamFailedAt=Date.now();throw error}
        }
      }
      return value
    } catch(error) {Object.assign(call,{finishedAt:Date.now(),error:error.code??error.name});throw error}
  },
  speechOptions: { engine: liveSpeech.effective.engine, voice: liveSpeech.effective.voice, qwen:observedQwen } })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const base = 'http://127.0.0.1:' + server.address().port
const get = path => fetch(base + '/api/' + path).then(r => r.json())
const post = async (path, body) => {
  const r = await fetch(base + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) {
    const body=await r.json().catch(()=>({}))
    let detail=String(body.error ?? body.message ?? '').slice(0,400)
    for(const [name,value] of Object.entries(process.env))if(/KEY|TOKEN|SECRET|PASSWORD/.test(name) && value?.length>6)detail=detail.replaceAll(value,'[redacted]')
    throw Error(path + ': ' + r.status + (detail?' '+detail:''))
  }
  return r.json()
}
const result = { kind: `Synthetic Chinese waveform through real browser microphone, VAD, ${localAsr?'local Zipformer':'selected DashScope'} ASR, DeepSeek and Qwen TTS. Digital output recording; not a human or physical speaker recording.`, fixture, duration, pageUrl,
  inputSha256:createHash('sha256').update(wav).digest('hex'),
  sourceHashes:Object.fromEntries(['apps/cohost/speech-output.mjs','scripts/qwen-realtime-client.mjs','scripts/qwen-audio-client.mjs','vendor/airi/packages/pipelines-audio/src/speech-pipeline.ts','vendor/airi/packages/pipelines-audio/src/types.ts','vendor/airi/packages/pipelines-audio/src/eventa.ts','vendor/airi/packages/pipelines-audio/dist/index.mjs','vendor/airi/packages/stage-ui/src/composables/streaming-recognition.ts','apps/cohost/fun-asr.mjs','apps/cohost/director.mjs','apps/cohost/participation.mjs','apps/cohost/participation-stream.mjs','packages/cohost-contracts/floor.ts','vendor/airi/packages/stage-ui/src/composables/use-cohost-voice.ts','vendor/airi/packages/stage-ui/src/composables/use-cohost-media-host.ts'].filter(existsSync).map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')])),
  mode: ordinaryOnly ? 'diagnostic: speculative opportunities disabled, ordinary real reply' : 'normal',
  acceptance: 'A successful harness exit only means recording finished. Judge behavior from the recorded waveforms.',
  events: [], observations: [], errors: [], httpErrors: [], modelCalls, recognitionTrace, speechTrace, asrModel:localAsr?'sherpa-zipformer-zh':asrModel, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash' }
result.answerPreparationEnabled=answerPreparationEnabled
if(localAsr){
  result.asrModel='local-zipformer-small-ctc-zh-int8-2025-04-01'
  result.kind='Original synthetic waveform through browser file microphone, real VAD, local sherpa-onnx streaming ASR, real DeepSeek and Qwen TTS; rendered WebAudio recording.'
  result.localAsr={version:'1.13.8',runtimeDir:localAsr.runtimeDir,modelDir:localAsr.modelDir}
  for(const file of ['apps/cohost/local-streaming-asr.mjs','scripts/local-streaming-asr.py','data/asr-local/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01/model.int8.onnx','data/asr-local/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01/tokens.txt'])
    result.sourceHashes[file]=createHash('sha256').update(readFileSync(file)).digest('hex')
}
result.openingPreparationEnabled=openingPreparationEnabled;result.tailMs=tailMs
result.sourceHashes['apps/cohost/opening-preparation.mjs']=createHash('sha256').update(readFileSync('apps/cohost/opening-preparation.mjs')).digest('hex')
for(const path of ['apps/cohost/answer-preparation.mjs','apps/cohost/prepared-speech.mjs','apps/cohost/pcm-onset.mjs','apps/cohost/airi-voice.mjs','apps/cohost/live-listening.mjs','apps/cohost/server.mjs','apps/cohost/participation-model.mjs'])
  result.sourceHashes[path]=createHash('sha256').update(readFileSync(path)).digest('hex')
const at = () => Date.now()
const originalEvent = director.event.bind(director)
director.event = event => { result.events.push({ at: at(), ...event }); return originalEvent(event) }
let lastGate=''
const originalConsume=director.consume.bind(director)
director.consume=id=>{
  const candidate=director.candidate
  if(candidate?.listening) {
    const state={id,quiet:director.listening.quiet,relevant:director.listening.relevant(candidate.text),
      ready:candidate.preparedSpeech?.ready,playable:candidate.preparedSpeech?.playable,durationMs:candidate.preparedSpeech?.durationMs,failed:candidate.preparedSpeech?.failed,expired:Date.now()>=candidate.expiresAt}
    const key=JSON.stringify(state)
    if(key!==lastGate){lastGate=key;result.observations.push({at:at(),kind:'listening-gate',...state})}
  }
  return originalConsume(id)
}
let browser, context, page, poll, progress
try {
  const config = await get('services/config')
  await post('services/config', { module: 'recognition', revision: config.recognition.revision, value: localAsr
    ? { provider: 'local', model: 'sherpa-zipformer-zh' } : { provider: 'dashscope', model: 'fun-asr-realtime' } })
  console.log(JSON.stringify({ phase: 'providers-ready' }))
  if (characters.catalog) await post('characters', { revision: null, value: characters.catalog.value })
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: [
    '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-audio-capture=' + fixture + '%noloop',
  ] })
  context = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ['microphone'], locale: 'zh-CN' })
  await context.addInitScript(() => {
    localStorage.setItem('onboarding/completed', 'true')
    localStorage.setItem('cohost/enabled', 'true')
    // Passive audio taps. Preserve the application's connections and cancellation behavior.
    const connect = AudioNode.prototype.connect
    const mic = AudioContext.prototype.createMediaStreamSource
    const taps = new WeakMap()
    window.audioTrial = { blocks: [], marks: [], epoch:crypto.randomUUID() }
    function tap(ctx, kind) {
      let group = taps.get(ctx)
      if (!group) { group = {}; taps.set(ctx, group) }
      if (group[kind]) return group[kind]
      const recorder = ctx.createScriptProcessor(512, 1, 1)
      const silent = ctx.createGain(); silent.gain.value = 0
      connect.call(recorder, silent); connect.call(silent, ctx.destination)
      recorder.onaudioprocess = e => {
        const pcm = e.inputBuffer.getChannelData(0)
        const clock = ctx.getOutputTimestamp()
        // Retain silence too, so onset/offset can be calculated from rendered samples.
        window.audioTrial.blocks.push({ kind, at: clock.performanceTime + performance.timeOrigin + (e.playbackTime - clock.contextTime) * 1000,
          time: e.playbackTime, rate: ctx.sampleRate, encoding: 's16', pcm: Array.from(pcm, value => Math.round(Math.max(-1, Math.min(1, value)) * 32767)) })
      }
      group[kind] = recorder; return recorder
    }
    AudioNode.prototype.connect = function(target, ...args) {
      const value = connect.call(this, target, ...args)
      if (target === this.context.destination && this.context.sampleRate === 48000) connect.call(this, tap(this.context, 'output'))
      return value
    }
    AudioContext.prototype.createMediaStreamSource = function(stream) {
      const source = mic.call(this, stream)
      // The cohost creates its meter source before the VAD source. Record once per context.
      if (this.sampleRate === 48000 && !taps.get(this)?.input) connect.call(source, tap(this, 'input'))
      window.audioTrial.marks.push({ kind: 'microphone-source', at: Date.now(), rate: this.sampleRate })
      return source
    }
  })
  await context.route('http://127.0.0.1:8787/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if(path.includes('/stage/recognition/')) {
      const body=route.request().postDataJSON()
      result.observations.push({at:at(),kind:'recognition-request',path,utterance:body.utterance,sequence:body.sequence,bytes:body.pcm?Buffer.from(body.pcm,'base64').length:0})
    }
    if (path.includes('/stage/event')) {
      try { result.observations.push({ at: at(), kind: 'browser-event', body: route.request().postDataJSON() }) } catch {}
    }
    // Continue streams, including recognition/open, without buffering their body.
    if (path === '/api/status/events' || path.includes('/stage/audio/') || path.endsWith('/recognition/open')) return route.continue({ url: base + path })
    await route.fulfill({ response: await route.fetch({ url: base + path }) })
  })
  page = await context.newPage()
  page.on('response', response => {
    if(response.status()>=400)result.httpErrors.push({at:at(),path:new URL(response.url()).pathname,status:response.status()})
  })
  page.on('pageerror', e => result.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') result.errors.push(m.text().slice(0, 240)) })
  await page.goto(pageUrl)
  console.log(JSON.stringify({ phase: 'page-loaded' }))
  const deadline = Date.now() + 90000
  let ready
  while (Date.now() < deadline) {
    ready = await get('status')
    if (ready.airi.stages.some(s => s.ready)) break
    await new Promise(r => setTimeout(r, 250))
  }
  const stage = ready.airi.stages.find(s => s.ready)
  if (!stage) throw Error('AIRI stage did not become ready')
  result.configuration = ready.configuration
  await post('live/start', {})
  if (process.argv.includes('--listen-only')) {
    const state = await get('status')
    await post('hosting', { action: 'stop', revision: state.hosting.revision })
  }
  result.startedAt = at()
  let last = ''
  poll = setInterval(async () => {
    try {
      const s = await get('status')
      const state = { busy: s.busy, hostSpeaking: s.hostSpeaking, turn: s.turn, candidate: s.director.candidate,
        decision: s.director.lastDecision, participation: s.participation, capture: s.airi.capture,
        entries: s.room.entries.filter(e => e.role === 'assistant' || e.role === 'host') }
      const text = JSON.stringify(state)
      if (text !== last) { last = text; result.observations.push({ at: at(), kind: 'status', ...state }) }
    } catch {}
  }, 100)
  await post('airi/start', { stage: stage.stage || 'web', owner: stage.owner, capture: true })
  console.log(JSON.stringify({ phase: 'capture', seconds: duration, label, stage: stage.stage }))
  progress = setInterval(async () => {
    const s = await get('status').catch(() => null)
    if (s) console.log(JSON.stringify({ phase: 'audio-progress', mode: s.director.mode, capture: s.airi.capture,
      captureReady: s.airi.captureReady, hostSpeaking: s.hostSpeaking, events: result.events.length,
      turns: s.room.entries.filter(e => e.role === 'assistant').length, error: s.airi.error }))
  }, 15000)
  await page.waitForFunction(()=>window.audioTrial.marks.some(mark=>mark.kind==='microphone-source' && mark.rate===48000),{},{timeout:90000})
  result.microphoneReadyAt=at()
  result.recordingEpoch=await page.evaluate(()=>window.audioTrial.epoch)
  await new Promise(r => setTimeout(r, duration * 1000 + tailMs))
  result.finishedAt = at()
  result.final = await get('status')
  result.transportHealthy = result.final.airi.capture && result.final.airi.captureReady && !result.final.airi.error
  await post('airi/stop', { owner: stage.owner })
  await new Promise(r => setTimeout(r, 500))
  const audio = await page.evaluate(() => window.audioTrial)
  result.recordingContinuous=audio.epoch===result.recordingEpoch && audio.marks.some(mark=>mark.kind==='microphone-source' && mark.rate===48000)
  if(!result.recordingContinuous) { result.transportHealthy=false;result.error='Recording was reset during the trial';process.exitCode=1 }
  writeFileSync(dir + '/' + label + '-audio.json', JSON.stringify(audio))
  result.audioMarks = audio.marks
  result.audioBlocks = audio.blocks.length
  await page.screenshot({ path: dir + '/' + label + '.png' })
  result.harnessCompleted = true
} catch (error) {
  result.error = error.message; process.exitCode = 1
  if (page) {
    const audio = await page.evaluate(() => window.audioTrial).catch(() => null)
    if (audio) {
      writeFileSync(dir + '/' + label + '-audio.json', JSON.stringify(audio))
      result.audioMarks = audio.marks; result.audioBlocks = audio.blocks.length
    }
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(0, 5000)
    await page.screenshot({ path: dir + '/' + label + '-failure.png' }).catch(() => {})
  }
}
finally {
  clearInterval(poll)
  clearInterval(progress)
  result.final ??= await get('status').catch(() => null)
  const liveAfter = await liveRead('status')
  result.userSessionUnchanged = JSON.stringify(liveBefore.room.entries) === JSON.stringify(liveAfter.room.entries)
  writeFileSync(dir + '/' + label + '.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ error: result.error, audioBlocks: result.audioBlocks, userSessionUnchanged: result.userSessionUnchanged,
    events: result.events.length, entries: result.final?.room.entries.filter(e => e.role === 'host' || e.role === 'assistant').map(({ role, text, status, interruptionReason }) => ({ role, text, status, interruptionReason })), errors: result.errors.slice(0, 5) }))
  await context?.unrouteAll({ behavior: 'ignoreErrors' })
  await browser?.close()
  server.closeAllConnections(); await new Promise(r => server.close(r))
}
