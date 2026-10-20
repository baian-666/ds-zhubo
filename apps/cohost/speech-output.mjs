import { createQwenSessionCache, streamQwen, MODEL, qwenFailureMessage } from '../../scripts/qwen-realtime-client.mjs'
import { randomUUID } from 'node:crypto'
import { localSpeechRuntime, indexSpeechRuntime } from './local-speech.mjs'
import { speechProviders } from '../../packages/cohost-contracts/speech.ts'
import { speechSettings } from './runtime-settings.mjs'
import { normalizeSpeechStyle } from './speech-style.mjs'
import { loadQwenClone, validateQwenClone } from './qwen-clone.mjs'
import { AUDIO_MODEL, streamQwenAudio, qwenAudioTaskAge } from '../../scripts/qwen-audio-client.mjs'
import { PcmOnset } from './pcm-onset.mjs'

const streamSelectedQwen = options => options.model === AUDIO_MODEL ? streamQwenAudio(options) : streamQwen(options)

function fail(message, status = 502) { const error = new Error(message); error.status = status; throw error }

/** Prepares cloud sentences concurrently. Local workers retain exclusive model access. */
export class SpeechOutput {
  constructor({ engine = process.env.COHOST_TTS_PROVIDER || 'siliconflow', voice = process.env.COHOST_TTS_VOICE,
    qwenKey = process.env.DASHSCOPE_API_KEY, fetchImpl = fetch, qwen = streamSelectedQwen, qwenClone,
    startLocal = engine => (engine==='index'?indexSpeechRuntime:localSpeechRuntime).ensure() } = {}) {
    this.fetch = fetchImpl; this.qwen = qwen; this.qwenKey = qwenKey
    this.startLocal = startLocal
    this.qwenClone = qwenClone
    this.cache = createQwenSessionCache({maxIdle:2}); this.pending = new Set(); this.active = 0; this.waiting = []
    this.configure(engine, voice)
  }
  configure(engine, voice) {
    const selected=speechSettings(engine,voice)
    if (this.pending.size) fail('请等当前语音结束后再更换声音', 409)
    const qwenTarget = selected.engine === 'qwen' && selected.voice === '克隆音色'
      ? (this.qwenClone ? validateQwenClone(this.qwenClone) : loadQwenClone()) : { model: MODEL, voice: selected.voice }
    this.qwenTarget = qwenTarget
    this.cache.clear(); this.engine = selected.engine; this.voice = selected.voice; this.revision = randomUUID()
  }
  get localUrl() { return `http://127.0.0.1:${this.engine==='index'?8794:8793}` }
  get localName() { return this.engine==='index'?'IndexTTS':'Aqua' }
  snapshot() {
    const provider = speechProviders.find(item => item.id === this.engine)
    return { schemaVersion: 1, revision: this.revision, engine: this.engine, voice: this.voice,
      model: this.engine === 'qwen' ? this.qwenTarget.model : provider.model,
      capabilities: { ...provider.capabilities, ...(this.engine === 'qwen' && this.voice === '克隆音色' ? { reference: true } : {}),
        ...(this.engine === 'qwen' ? { emotion: false } : {}) },
      pending: this.pending.size }
  }
  async prepare({ signal } = {}) {
    if (this.engine === 'qwen') {
      if (!this.qwenKey) fail('请先在本机试听页配置百炼密钥', 503)
      const controller=new AbortController()
      const combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])])
      this.pending.add(controller)
      try {
        // Match the two synthesis slots. A prefetched sentence must not start with a cold connection.
        await Promise.all([0,1].map(index=>this.qwen({key:this.qwenKey,...this.qwenTarget,validateOnly:true,retainTask:index===0 && this.qwenTarget.model===AUDIO_MODEL,sessionCache:this.cache,signal:combined})))
      }
      catch (error) { controller.abort();this.cache.clear();fail(qwenFailureMessage(error), 502) }
      finally { this.pending.delete(controller) }
    } else if (['aqua','index'].includes(this.engine)) {
      let response
      const health = () => this.fetch(this.localUrl+'/health', { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]), redirect: 'error' })
      try { response = await health() }
      catch {
        if(signal?.aborted)fail('语音启动已取消',409)
        try {await this.startLocal(this.engine);response=await health()}
        catch {fail(`${this.localName} 本地语音尚未启动，请检查显存及语音服务`,503)}
      }
      if (!response.ok) fail(`${this.localName} 本地语音尚未就绪`, 503)
      const status=await response.json()
      if (!status.ok || status.engine!==(this.engine==='index'?'index-2.5':'aqua-v3')) fail(`${this.localName} 本地语音尚未就绪`, 503)
    }
  }
  async maintainWarmth() {
    if(this.engine!=='qwen' || !this.qwenKey || this.pending.size || Date.now()-(this.lastWarmAt??0)<5000)return
    const warmTask=this.qwenTarget.model===AUDIO_MODEL
    const prepareTask=warmTask && !this.cache.available(Infinity,socket=>qwenAudioTaskAge(socket)<10000)
    const missing=warmTask ? Number(prepareTask || this.cache.available(20000)<2) : 2-this.cache.available(20000)
    if(!missing)return
    this.lastWarmAt=Date.now()
    const controller=new AbortController();this.warmController=controller;this.pending.add(controller)
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])
    // Fill missing slots without borrowing the sockets an answer can use immediately.
    const cache={take:(key,voice,model)=>prepareTask && this.cache.available()>1
      ?this.cache.take(key,voice,model,socket=>!Number.isFinite(qwenAudioTaskAge(socket))):undefined,put:(...args)=>{
      if(signal.aborted){try{args[0].close()}catch{};return}
      this.cache.put(...args)
    }}
    // One empty prepared task plus one connection. Refresh one at a time; with two
    // foreground sentences there can be at most three active provider tasks.
    try {await Promise.all(Array.from({length:missing},()=>this.qwen({key:this.qwenKey,...this.qwenTarget,validateOnly:true,retainTask:prepareTask,sessionCache:cache,signal})))}
    catch {controller.abort()}
    finally {this.pending.delete(controller);if(this.warmController===controller)this.warmController=null}
  }
  cancelWarmth() {this.warmController?.abort();this.cache.clear(socket=>Number.isFinite(qwenAudioTaskAge(socket)))}
  acquire(signal) {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.waiting.indexOf(start)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(Object.assign(new Error('语音请求已取消'), { status: 409 }))
      }
      const start = () => {
        signal.removeEventListener('abort', cancel)
        if (signal.aborted) { cancel(); return }
        this.active++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.active--
          this.waiting.shift()?.()
        })
      }
      if (signal.aborted) { cancel(); return }
      // Playback orders the results. Two cloud requests hide the next sentence's startup latency.
      if (this.active < (this.engine === 'qwen' ? 2 : 1)) start()
      else {
        this.waiting.push(start)
        signal.addEventListener('abort', cancel, { once: true })
      }
    })
  }
  async stream(text, { signal, turnSignal, emit, speechStyle, trimStart=false }) {
    if (this.pending.size >= 5) fail('语音请求过多，请等待', 429)
    const controller = new AbortController()
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(turnSignal ? [turnSignal] : [])])
    let release = () => {}
    this.pending.add(controller)
    let timer, reader
    const aborted = () => fail('语音请求已取消', 409)
    const onset=trimStart?new PcmOnset():null
    const send = event => { if (combined.aborted) aborted();const frame=onset?onset.accept(event):event;if(frame)emit(frame) }
    try {
      release = await this.acquire(combined)
      if (combined.aborted) aborted()
      timer = setTimeout(() => controller.abort(), 45000)
      if (this.engine === 'qwen') {
        const result = await this.qwen({ key: this.qwenKey, ...this.qwenTarget, text,
          speechStyle: normalizeSpeechStyle(speechStyle),
          signal: combined, sessionCache: this.cache, onEvent: send })
        send({ type: 'done', ...result }); return
      }
      let response
      const releasedBy=Date.now()+(this.engine==='index'?5000:1200)
      while (true) {
        if(combined.aborted)aborted()
        response = await this.fetch(this.localUrl+'/tts', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...(this.engine === 'index' ? {style:normalizeSpeechStyle(speechStyle)} : {}) }), signal: combined, redirect: 'error' })
        if(response.status!==409)break
        // HTTP cancellation can precede the worker's next yield. Wait briefly
        // for its old generator to release the model; no new synthesis ran yet.
        await response.body?.cancel()
        if(Date.now()>=releasedBy)fail(`${this.localName} 仍在结束上一段语音，请稍后重试`)
        await new Promise(resolve=>setTimeout(resolve,50))
      }
      if (!response.ok || !response.body) fail(`${this.localName} 本地语音生成失败`)
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '', bytes = 0, done = false
      while (true) {
        const frame = await reader.read()
        if (combined.aborted) aborted()
        if (frame.done) break
        buffer += decoder.decode(frame.value, { stream: true })
        if (buffer.length > 2_000_000) fail('语音流过大')
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
          if (event.type === 'error') fail(`${this.localName} 本地语音生成失败`)
          if (event.type === 'audio') {
            if (done || event.sampleRate !== (this.engine==='index'?22050:24000) || typeof event.pcm !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.pcm)) fail('语音流格式异常')
            const pcm = Buffer.from(event.pcm, 'base64'); bytes += pcm.length
            if (!pcm.length || pcm.length % 2 || bytes > 6_000_000) fail('语音流格式异常')
            send({ type: 'audio', pcm: event.pcm, sampleRate: event.sampleRate })
          } else if (event.type === 'done') {
            if (done || !bytes) fail('语音流提前结束')
            done = true
            send({ type: 'done', firstPcmMs: Number(event.firstPcmMs), totalMs: Number(event.totalMs) })
          }
        }
      }
      if (!done || buffer.trim()) fail('语音流提前结束')
    } catch (error) {
      if (combined.aborted) aborted()
      if (error.status) throw error
      fail('语音服务连接失败，请检查当前声音配置')
    } finally {
      clearTimeout(timer); release(); this.pending.delete(controller)
      await reader?.cancel().catch(() => {})
    }
  }
  close() { for (const controller of this.pending) controller.abort(); this.cache.clear() }
}
