import { randomUUID } from 'node:crypto'
import { recognizeCloud } from './recognition-request.mjs'
import { FunAsrConnections, FunAsrSegment, verifyFunAsr } from './fun-asr.mjs'
import { recognitionSchema } from './module-settings.mjs'
import { safeParse } from 'valibot'
import { LocalStreamingAsr } from './local-streaming-asr.mjs'

function fail(status, message) { const error = new Error(message); error.status = status; throw error }
const stages = new Set(['desktop', 'web'])

/** One AIRI stage owns capture and playback. Closing its lease cancels all pending cloud requests. */
export class AiriVoice {
  constructor({ key = process.env.SILICONFLOW_API_KEY, realtimeKey = process.env.DASHSCOPE_API_KEY, realtimeOptions = {}, recognitionAdapter, localRecognitionAdapter = new LocalStreamingAsr(), recognition = () => ({provider:'siliconflow',model:'FunAudioLLM/SenseVoiceSmall'}), fetchImpl = fetch, now = Date.now, onStop = () => {}, onCaptureStop = () => {} } = {}) {
    this.key = key; this.fetch = fetchImpl; this.now = now; this.onStop = onStop
    this.stages = new Map(); this.session = null; this.error = ''; this.pending = new Set()
    this.lastText = ''; this.asrMs = null; this.asrAttempts = null
    this.capturePending=new Set();this.onCaptureStop=onCaptureStop
    this.realtimeKey=realtimeKey;this.realtimeOptions=realtimeOptions;this.recognition=recognition;this.segments=new Map()
    this.recognitionConnections=new FunAsrConnections()
    this.recognitionTexts=new Map()
    this.recognitionAdapter=recognitionAdapter
    this.localRecognitionAdapter=localRecognitionAdapter
  }
  recognitionReady(provider=this.recognition().provider){
    if(provider==='local')return this.localRecognitionAdapter.available()
    return Boolean(this.recognitionAdapter || (provider==='dashscope'?this.realtimeKey:this.key))
  }
  async verifyRecognition(value,signal){
    if(!safeParse(recognitionSchema,value).success)fail(400,'识别服务配置无效')
    if(!this.recognitionReady(value.provider))fail(503,value.provider==='local'?'本地识别模型或运行时尚未安装':'请先在本机 .env 配置所选识别服务密钥')
    if(value.provider==='local') {
      try {await this.localRecognitionAdapter.prepare(signal)}
      finally {this.localRecognitionAdapter.clear()}
    } else if(this.recognitionAdapter)await this.recognitionAdapter.prepare(signal)
    else if(value.provider==='dashscope')await verifyFunAsr({...this.realtimeOptions,key:this.realtimeKey,signal})
  }
  async prepareRecognition(revision,signal){
    if(!['dashscope','local'].includes(this.recognition().provider)||!this.acceptsCapture(revision))fail(409,'收音批次已失效')
    const controller=new AbortController();this.capturePending.add(controller)
    try{
      const adapter=this.recognition().provider==='local'?this.localRecognitionAdapter:this.recognitionAdapter
      if(adapter)return await adapter.prepare(AbortSignal.any([controller.signal,...(signal?[signal]:[])]))
      // A following segment can start before the previous task returns its socket.
      const options={...this.realtimeOptions,key:this.realtimeKey,connections:this.recognitionConnections,signal:AbortSignal.any([controller.signal,...(signal?[signal]:[])])}
      const preparing=[verifyFunAsr(options),verifyFunAsr(options)]
      try{await Promise.all(preparing)}
      catch(error){controller.abort();await Promise.allSettled(preparing);throw error}
    }
    finally{this.capturePending.delete(controller)}
  }
  /** Stream ownership includes the capture revision. Ending capture never closes speech playback. */
  openRecognition(id, revision, emit, signal) {
    if(!['dashscope','local'].includes(this.recognition().provider)||!this.acceptsCapture(revision))fail(409,'实时识别配置或收音批次已失效')
    if(!Number.isSafeInteger(id)||id<=0)fail(400,'无效识别编号')
    if(this.segments.has(id)||this.segments.size>=3)fail(429,'识别积压较多，请暂停片刻')
    if(this.recognitionTexts.size>=8)fail(429,'识别积压较多，请暂停片刻')
    this.recognitionTexts.set(id,null)
    const options={...this.realtimeOptions,key:this.realtimeKey,signal,emit:event=>{
      if(event.type==='final' && this.acceptsCapture(revision) && this.recognitionTexts.has(id))this.recognitionTexts.set(id,event.text.trim())
      emit(event)
    },connections:this.recognitionConnections}
    let task
    const adapter=this.recognition().provider==='local'?this.localRecognitionAdapter:this.recognitionAdapter
    try{task=adapter?adapter.open(options):new FunAsrSegment(options)}
    catch(error){this.recognitionTexts.delete(id);throw error}
    this.segments.set(id,{task,revision})
    task.done.then(result=>{
      if(this.acceptsCapture(revision)&&this.segments.get(id)?.task===task){this.lastText=result.text;this.asrMs=result.asrMs;this.asrAttempts=result.asrAttempts??1}
    }).catch(()=>{}).finally(()=>{if(this.segments.get(id)?.task===task)this.segments.delete(id)})
    return task
  }
  recognitionSegment(id,revision){
    const item=this.segments.get(id)
    if(!this.acceptsCapture(revision)||item?.revision!==revision)fail(409,'实时识别会话已失效')
    return item.task
  }
  previewRecognition(id,text) {
    if(!this.recognitionTexts.has(id))return null
    const parts=[...this.recognitionTexts].filter(([key])=>key<=id).sort((a,b)=>a[0]-b[0])
    if(parts.some(([key,value])=>key<id && value===null))return null
    return parts.map(([key,value])=>key===id?text:value).filter(Boolean).join('，').slice(0,2000)
  }
  acknowledgeRecognition(id) {for(const key of this.recognitionTexts.keys())if(key<=id)this.recognitionTexts.delete(key)}
  cancelRecognition(){for(const {task} of this.segments.values())task.close(Object.assign(new Error('收音已停止'),{status:409}));this.segments.clear();this.recognitionTexts.clear();this.recognitionConnections.clear();this.recognitionAdapter?.clear();this.localRecognitionAdapter.clear()}
  snapshot() {
    return { configured: this.recognitionReady(), active: Boolean(this.session), stage: this.session?.stage ?? null,
      control: this.session?.control ?? null, capture: Boolean(this.session?.capture), captureReady:Boolean(this.session?.captureReady), captureRevision:this.session?.captureRevision ?? 0, ready: Boolean(this.session?.ready), pending: this.pending.size,
      error: this.error, final: this.lastText, asrMs: this.asrMs, asrAttempts: this.asrAttempts,
      stages: [...this.stages.values()].filter(state => this.now() - state.at < 3000).map(({stage,owner,ready}) => ({ stage, owner, ready })) }
  }
  pulse({ stage, owner, ready, listening = false, captureRevision = 0 }, activeTurn) {
    if (!stages.has(stage) || typeof owner !== 'string' || owner.length < 8 || owner.length > 100 || typeof ready !== 'boolean' || typeof listening !== 'boolean') fail(400, '无效舞台心跳')
    this.tick()
    for (const [id, state] of this.stages) if (this.now() - state.at > 3000) this.stages.delete(id)
    this.stages.set(owner, {stage, owner, at:this.now(), ready})
    const session = this.session
    if (!session || session.stage !== stage || (session.owner && session.owner !== owner)) return {run:null}
    if (!session.owner) session.owner = owner
    session.at = this.now(); session.ready = ready
    session.captureReady = session.capture && listening && captureRevision===session.captureRevision
    return {run:session.id, capture:session.capture, recognition:this.recognition().provider, captureRevision:session.captureRevision, turn:activeTurn?.airiRun === session.id && !activeTurn.controller.signal.aborted
      ? {id:activeTurn.id, audioId:activeTurn.audioId, text:activeTurn.answer, done:activeTurn.generationDone, listening:Boolean(activeTurn.listening), speechBoundaries:activeTurn.speechBoundaries ?? [],floorReview:activeTurn.floorReview??null} : null}
  }
  start(stage, control, capture = true, renderer) {
    this.tick()
    if (typeof capture !== 'boolean') fail(400, '无效收音设置')
    if (capture && !this.recognitionReady()) fail(503, '请先配置所选识别服务的密钥并重启联调台')
    if (this.session && (this.session.control !== control || this.session.stage !== stage || (renderer !== undefined && renderer !== this.session.owner))) fail(409, '已有舞台正在使用语音，请先停止')
    // The separate debug console can select a stage. Native windows select their exact renderer identity.
    const available = [...this.stages.values()].filter(item => item.stage === stage && item.ready && this.now() - item.at < 3000)
    const target = renderer !== undefined ? available.find(item => item.owner === renderer)
      : available.find(item => item.owner === control) ?? available[0]
    if (!stages.has(stage) || !target) fail(409, '所选 AIRI 舞台尚未连接，请先打开舞台')
    if (this.session) return this.setCapture(control,capture)
    this.error = ''; this.lastText = ''; this.asrMs = null; this.asrAttempts = null
    this.session = {id:randomUUID(), stage, control, capture, captureRevision:1, captureReady:false, owner:target.owner, ready:true, at:this.now()}
    return this.snapshot()
  }
  setCapture(control, capture, error='') {
    this.tick()
    if(!this.session || this.session.control!==control)fail(409,'请在当前舞台控制麦克风')
    if(typeof capture!=='boolean')fail(400,'无效收音设置')
    if(capture&&!this.recognitionReady())fail(503,'请先配置所选识别服务的密钥并重启联调台')
    if(this.session.capture===capture)return this.snapshot()
    this.session.capture=capture;this.session.captureRevision++;this.session.captureReady=false;this.error=error
    for(const request of this.capturePending)request.abort()
    this.capturePending.clear()
    this.cancelRecognition()
    if(!capture)this.onCaptureStop()
    return this.snapshot()
  }
  acceptsCapture(revision) {return Boolean(this.session?.capture&&revision===this.session.captureRevision)}
  authenticate(request) {
    this.tick()
    if (!this.session?.owner || request.headers.authorization !== 'Bearer ' + this.session.id + ':' + this.session.owner) fail(409, '语音会话已失效')
    return this.session
  }
  stop(error = '') {
    if (!this.session) return
    this.session = null; this.error = error
    for (const controller of this.pending) controller.abort()
    for (const controller of this.capturePending) controller.abort()
    this.pending.clear()
    this.capturePending.clear()
    this.cancelRecognition()
    this.onStop()
  }
  tick() { if (this.session && this.now() - this.session.at > 3500) this.stop('舞台连接已断开，收音已停止') }
  cancelRequests() { for (const controller of this.pending) controller.abort() }

  async cloud(path, body, { signal, turnSignal } = {}) {
    if (path === 'transcriptions' && !this.session?.capture) fail(409, '麦克风未开启')
    const run = this.session?.id
    const captureRevision=this.session?.captureRevision
    if (!run) fail(409, '语音会话已停止')
    if (this.pending.size >= 5) fail(429, '语音请求过多，请等待')
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted || turnSignal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, {once:true}); turnSignal?.addEventListener('abort', abort, {once:true})
    this.pending.add(controller)
    if(path==='transcriptions')this.capturePending.add(controller)
    const timer = setTimeout(abort, 30000)
    const started = this.now()
    try {
      let result, attempts = 0
      if (path === 'transcriptions') {
        result = await recognizeCloud({ fetchImpl: this.fetch, key: this.key, body, signal: controller.signal,
          onAttempt: count => { attempts = count } })
      } else {
        const response = await this.fetch('https://api.siliconflow.cn/v1/audio/' + path, {
          method:'POST', headers:{Authorization:'Bearer ' + this.key, ...(path === 'speech' ? {'Content-Type':'application/json'} : {})},
          body, signal:controller.signal, redirect:'error' })
        if (!response.ok) { await response.body?.cancel(); fail(502, '云端语音调用失败，请检查账号额度和网络') }
        result = Buffer.from(await response.arrayBuffer())
      }
      if (controller.signal.aborted || this.session?.id !== run || (path==='transcriptions'&&!this.acceptsCapture(captureRevision))) fail(409, '已丢弃过期语音结果')
      if (path === 'transcriptions') {
        this.asrMs = this.now() - started
        this.asrAttempts = attempts
        const text = typeof result.text === 'string' ? result.text.replaceAll(this.key, '[已隐藏]').trim().slice(0,2000) : ''
        this.lastText = text
        return {text}
      }
      if (result.length < 44 || result.length > 8_000_000 || result.toString('ascii',0,4) !== 'RIFF') fail(502, '云端返回的音频不可播放')
      return result
    } catch (error) {
      if (error.status) throw error
      fail(controller.signal.aborted ? 409 : 502, controller.signal.aborted ? '语音请求已取消' : '云端语音连接失败')
    } finally {
      clearTimeout(timer); this.pending.delete(controller);this.capturePending.delete(controller)
      signal?.removeEventListener('abort',abort); turnSignal?.removeEventListener('abort',abort)
    }
  }
}
