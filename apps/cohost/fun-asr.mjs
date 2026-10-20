import { randomUUID } from 'node:crypto'

const failure = (message, status = 502) => Object.assign(new Error(message), { status })

/** Keeps at most two completed-task sockets during capture. No audio or transcript is cached. */
export class FunAsrConnections {
  constructor(){this.idle=[]}
  claimHedge(){if(this.hedging)return null;this.hedging=true;return ()=>{this.hedging=false}}
  take(reserve=0){
    for(const item of [...this.idle])if(item.socket.readyState!==1){
      clearTimeout(item.timer);this.idle=this.idle.filter(value=>value!==item)
    }
    if(this.idle.length>reserve){const item=this.idle.pop();clearTimeout(item.timer);return item.socket}
  }
  put(socket){
    if(socket.readyState!==1||this.idle.length>=2){try{socket.close()}catch{};return}
    const item={socket,timer:setTimeout(()=>{this.idle=this.idle.filter(value=>value!==item);try{socket.close()}catch{}},120000)}
    item.timer.unref?.();this.idle.push(item)
  }
  clear(){for(const item of this.idle){clearTimeout(item.timer);try{item.socket.close()}catch{}}this.idle=[]}
}

/** One VAD segment owns one duplex task. Partial results never become final transcripts.
 * Opening, sending and finishing are bounded. Cancellation closes the socket and drops all results.
 */
export class FunAsrSegment {
  constructor({ key = process.env.DASHSCOPE_API_KEY, signal, emit = () => {}, WebSocketImpl = WebSocket,
    startTimeoutMs = 15000, finishTimeoutMs = 12000, lifetimeMs = 70000, connections, connectionReserve = 0, model = 'fun-asr-realtime', finishHedgeMs = 650, onMetric = () => {} } = {}) {
    if (!key) throw failure('请先在本机 .env 配置 DASHSCOPE_API_KEY', 503)
    if(!['fun-asr-realtime','paraformer-realtime-v2','qwen-audio-3.0-asr-flash-streaming'].includes(model))throw failure('不支持的实时识别模型',400)
    this.id = randomUUID(); this.state = 'opening'; this.sequence = 0; this.bytes = 0
    this.sentences = new Map(); this.emit = emit; this.finishTimeoutMs = finishTimeoutMs
    this.retryOptions={key,WebSocketImpl,model};this.finishHedgeMs=finishHedgeMs;this.audioFrames=[];this.attempts=1
    this.connections=connections;this.listeners=[]
    this.onMetric=onMetric
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    this.done.catch(() => {})
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.ready.catch(() => {})
    this.signal = signal; this.abort = () => this.close(failure('识别已取消', 409))
    if (signal?.aborted) { this.abort(); return }
    signal?.addEventListener('abort', this.abort, { once: true })
    this.deadline = setTimeout(() => this.close(failure('识别录音过长，请说短句', 504)), lifetimeMs)
    this.timer = setTimeout(() => this.close(failure('实时识别连接超时，请检查网络', 504)), startTimeoutMs)
    try {
      this.socket = connections?.take(connectionReserve) ?? new WebSocketImpl('wss://dashscope.aliyuncs.com/api-ws/v1/inference', { headers: { Authorization: 'Bearer ' + key } })
      const listen=(type,listener)=>{this.listeners.push([type,listener]);this.socket.addEventListener(type,listener)}
      const start=() => {
        if (this.state !== 'opening') return
        this.socket.send(JSON.stringify({ header: { action: 'run-task', task_id: this.id, streaming: 'duplex' },
          payload: { task_group: 'audio', task: 'asr', function: 'recognition', model,
            parameters: { format: 'pcm', sample_rate: 16000, max_sentence_silence: 650 }, input: {} } }))
      }
      listen('open', start)
      listen('message', event => {
        try { this.receive(JSON.parse(String(event.data))) }
        catch { this.close(failure('实时识别返回无效数据')) }
      })
      listen('error', () => this.close(failure('实时识别连接失败，请检查网络或模型权限')))
      listen('close', () => { if (this.state !== 'closed') this.close(failure('实时识别连接中断，请重说这一句')) })
      if(this.socket.readyState===1)queueMicrotask(()=>{try{start()}catch{this.close(failure('实时识别连接已断开'))}})
    } catch { this.close(failure('实时识别连接失败')) }
  }
  receive(event) {
    if (this.state === 'closed' || event.header?.task_id !== this.id) return
    if (event.header.event === 'task-failed') { this.close(Object.assign(failure('实时识别服务拒绝请求，请检查北京地域密钥、权限或额度'),{providerCode:event.header.error_code})); return }
    if (event.header.event === 'task-started' && this.state === 'opening') {
      clearTimeout(this.timer); this.state = 'sending'; this.readyResolve(); this.emit({ type: 'ready' }); return
    }
    if (event.header.event === 'result-generated' && ['sending', 'finishing'].includes(this.state)) {
      const sentence = event.payload?.output?.sentence
      if (!sentence || sentence.heartbeat) return
      const id = sentence.sentence_id
      if (!Number.isSafeInteger(id) || id < 0 || id > 200 || typeof sentence.text !== 'string' || sentence.text.length > 2000)
        throw Error('Invalid sentence')
      if (this.sentences.has(id)) return
      if (sentence.sentence_end === true) this.sentences.set(id, sentence.text.trim())
      const text = [...this.sentences.entries()].sort((a,b) => a[0]-b[0]).map(([,text]) => text).join('')
      if (text.length > 2000) throw Error('Transcript too long')
      this.emit({ type: 'partial', text: (text + (sentence.sentence_end ? '' : sentence.text)).slice(0,2000), confirmed:text })
    }
    if (event.header.event === 'task-finished' && this.state === 'finishing') {
      const text = [...this.sentences.entries()].sort((a,b) => a[0]-b[0]).map(([,text]) => text).join('')
      this.complete(text,true)
    }
  }
  complete(text,reusable=false) {
    if(this.state!=='finishing')return
    const result={text,asrMs:Date.now()-this.finishedAt,...(this.attempts>1?{asrAttempts:this.attempts}:{})}
    // Publish the winning final transcript once; drafts from the retry stay private.
    if(!reusable)this.emit({type:'partial',text,confirmed:text})
    this.emit({type:'final',...result});this.resolve(result);this.close(undefined,reusable)
  }
  async hedgeFinal() {
    if(this.state!=='finishing' || !this.audioFrames.length)return
    const release=this.connections?this.connections.claimHedge():(()=>{})
    if(!release){
      // An earlier segment may still occupy the single retry slot. Give this
      // segment a bounded chance to claim it after release, without spawning more work.
      if(Date.now()-this.finishedAt<2000)this.hedgeTimer=setTimeout(()=>{void this.hedgeFinal()},200)
      return
    }
    // Keep one idle socket for the next live segment; a retry must not consume
    // the foreground reserve. Cold TLS takes 5–6 seconds on the
    // deployed network; the former 3-second startup limit killed retries before
    // run-task. Keep only one replay and leave the original eligible throughout.
    const frames=this.audioFrames
    let task
    try {
      this.onMetric({type:'hedge-start',task:this.id,at:Date.now()})
      task=new FunAsrSegment({...this.retryOptions,connections:this.connections,connectionReserve:1,finishHedgeMs:0,startTimeoutMs:9000,finishTimeoutMs:4500,lifetimeMs:14000})
      this.hedge=task;this.attempts=2
      await task.ready
      this.onMetric({type:'hedge-ready',task:this.id,at:Date.now()})
      let sequence=0
      for(const pcm of frames) {
        while(task.state==='sending' && this.state==='finishing' && task.socket.bufferedAmount>128000)
          await new Promise(resolve=>setTimeout(resolve,5))
        if(this.state!=='finishing' || task.state!=='sending')return
        task.write(pcm,sequence++)
      }
      const result=await task.finish(sequence)
      if(this.state==='finishing' && this.hedge===task && result.text.trim()){
        this.onMetric({type:'hedge-won',task:this.id,at:Date.now()})
        this.complete(result.text)
      }
    } catch(error) {
      if(this.state==='finishing')this.onMetric({type:'hedge-failed',task:this.id,at:Date.now(),status:error.status??502})
      /* A failed retry cannot suppress the original final result. */
    }
    finally {task?.close(failure('识别重试已结束',409));if(this.hedge===task)this.hedge=null;release()}
  }
  write(pcm, sequence) {
    if (this.state !== 'sending') throw failure('识别会话未就绪或已结束', 409)
    if (sequence !== this.sequence || !Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length % 2 || pcm.length > 16384)
      throw failure('识别音频分片无效或乱序', 400)
    if (this.bytes + pcm.length > 16000 * 2 * 55 || this.socket.bufferedAmount > 256000)
      throw failure('识别积压过多，请暂停后重试', 429)
    this.socket.send(pcm); this.sequence++; this.bytes += pcm.length
    if(this.finishHedgeMs>0)this.audioFrames.push(Buffer.from(pcm))
  }
  finish(sequence) {
    if (this.state !== 'sending' || sequence !== this.sequence) throw failure('识别结束顺序无效', 409)
    this.state = 'finishing'; this.finishedAt = Date.now()
    this.timer = setTimeout(() => this.close(failure('实时识别等待过久，请重说这一句', 504)), this.finishTimeoutMs)
    this.socket.send(JSON.stringify({ header: { action: 'finish-task', task_id: this.id, streaming: 'duplex' }, payload: { input: {} } }))
    if(this.finishHedgeMs>0 && this.bytes) {
      this.hedgeTimer=setTimeout(()=>{void this.hedgeFinal()},this.finishHedgeMs);this.hedgeTimer.unref?.()
    }
    return this.done
  }
  close(error,reusable=false) {
    if (this.state === 'closed') return
    this.state = 'closed'; clearTimeout(this.timer); clearTimeout(this.deadline);clearTimeout(this.hedgeTimer)
    this.hedge?.close(failure('原识别已结束',409));this.audioFrames=[]
    this.signal?.removeEventListener('abort', this.abort)
    this.readyReject(error ?? failure('识别已关闭', 409))
    for(const [type,listener] of this.listeners)this.socket?.removeEventListener(type,listener)
    if (error) this.reject(error)
    else this.resolve({ text: '', asrMs: 0 })
    if(reusable&&this.connections)this.connections.put(this.socket)
    else {try { this.socket?.close() } catch {}}
  }
}

/** Validates model access without sending audio or modifying the active voice. */
export async function verifyFunAsr(options) {
  const task = new FunAsrSegment(options)
  try {
    await task.ready
    try {await task.finish(0)}
    catch(error) {
      // Some compatible models accept the task but reject an empty access probe.
      // Never apply this exception to real audio or to authorization failures.
      if(error.providerCode!=='NO_VALID_AUDIO_ERROR')throw error
    }
  }
  finally { task.close() }
}
