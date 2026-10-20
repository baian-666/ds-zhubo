import { randomUUID } from 'node:crypto'
import { keyValid } from './qwen-credential.mjs'

export const AUDIO_MODEL = 'qwen-audio-3.1-tts-flash'
const preparedTasks=new WeakMap()
// The provider permits at most 23 seconds between text submissions. Retire at 20.
export const qwenAudioTaskAge=socket=>preparedTasks.has(socket)?Date.now()-preparedTasks.get(socket).at:Infinity
function keepPreparedTask(socket,taskId) {
  const detach=()=>{for(const type of ['message','close','error'])socket.removeEventListener(type,discard);preparedTasks.delete(socket)}
  const discard=event=>{
    if(event.type==='message' && typeof event.data==='string') {
      try {if(JSON.parse(event.data).header?.task_id!==taskId)return}catch{}
    }
    detach();try{socket.close()}catch{}
  }
  preparedTasks.set(socket,{taskId,at:Date.now(),detach})
  for(const type of ['message','close','error'])socket.addEventListener(type,discard)
}
export const validAudioClone = (model, voice) => model === AUDIO_MODEL && typeof voice === 'string'
  && /^qwen-audio-3\.1-tts-flash-[a-z0-9]{1,10}-[a-f0-9]{32}$/.test(voice)

/** DashScope TTS v2 protocol. A completed task can reuse its connection, never its audio. */
export function streamQwenAudio({ key, model = AUDIO_MODEL, voice, text = '', validateOnly = false, retainTask = false,
  signal, onEvent = () => {}, WebSocketImpl = WebSocket, timeoutMs = 45000, sessionCache } = {}) {
  if (!keyValid(key)) return Promise.reject(new Error('请先配置百炼 API Key。'))
  if (!validAudioClone(model, voice) || (!validateOnly && (typeof text !== 'string' || !text.trim() || text.length > 300)))
    return Promise.reject(new Error('请选择音色，输入 1–300 字的台词。'))
  if (signal?.aborted) return Promise.reject(new Error('试听已停止。'))
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let taskId = randomUUID().replaceAll('-', ''),retiringTask=null
    let socket, settled = false, started = false, submitted, bytes = 0, chunks = 0
    const stats = { model, voice, sampleRate: 24000, reusedConnection: false, connectMs: null, prepareMs: null, firstPcmMs: null, synthesisFirstPcmMs: null }
    const listeners = []
    const listen = (type, fn) => { listeners.push([type, fn]); socket.addEventListener(type, fn) }
    const finish = error => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      for (const [type, fn] of listeners) socket?.removeEventListener(type, fn)
      if (!error && sessionCache && socket?.readyState === 1) {
        if(validateOnly && retainTask)keepPreparedTask(socket,taskId)
        sessionCache.put(socket, key, voice, model,validateOnly && retainTask?20000:undefined)
      }
      else { try { socket?.close() } catch {} }
      if (error) reject(new Error(error))
      else resolve({ ...stats, chunks, audioSeconds: bytes / 48000, totalMs: performance.now() - start })
    }
    const abort = () => finish('试听已停止。')
    const timer = setTimeout(() => finish('语音请求超时，请稍后重试。'), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    const send = (action, payload) => socket.send(JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }))
    const submit = () => {
      submitted = performance.now()
      onEvent({type:'ready',connectMs:stats.connectMs,prepareMs:stats.prepareMs,reusedConnection:stats.reusedConnection,reusedTask:Boolean(stats.reusedTask)})
      send('continue-task',{input:{text:text.trim()}});send('finish-task',{input:{}})
    }
    const run = () => {
      try {
        stats.connectMs = performance.now() - start
        // User-selected automatic delivery: never send a director style as an instruction.
        send('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model,
          parameters: { text_type: 'PlainText', voice, format: 'pcm', sample_rate: 24000, volume: 50, rate: 1, pitch: 1, seed: 0 }, input: {} })
      } catch { finish('语音连接已中断。') }
    }
    try {
      if(!validateOnly)socket=sessionCache?.take(key,voice,model,socket=>qwenAudioTaskAge(socket)<20000)
      socket ??= sessionCache?.take(key, voice, model); stats.reusedConnection = Boolean(socket)
      const prepared=socket && preparedTasks.get(socket)
      prepared?.detach()
      socket ??= new WebSocketImpl('wss://dashscope.aliyuncs.com/api-ws/v1/inference', { headers: { Authorization: 'Bearer ' + key } })
      socket.binaryType = 'arraybuffer'
      listen('open', run)
      listen('message', event => {
        if (settled) return
        try {
          if (typeof event.data !== 'string') {
            if (!started || validateOnly || !(event.data instanceof ArrayBuffer)) throw new Error()
            const pcm = Buffer.from(event.data)
            if (!pcm.length || pcm.length % 2) throw new Error()
            bytes += pcm.length
            if (bytes > 6_000_000) return finish('试听音频超出长度限制。')
            chunks++
            if (stats.firstPcmMs === null) {
              stats.firstPcmMs = performance.now() - start
              stats.synthesisFirstPcmMs = performance.now() - submitted
            }
            onEvent({ type: 'audio', pcm: pcm.toString('base64'), sampleRate: 24000,
              firstPcmMs: stats.firstPcmMs, synthesisFirstPcmMs: stats.synthesisFirstPcmMs })
            return
          }
          if (event.data.length > 100000) throw new Error()
          const data = JSON.parse(event.data), header = data.header
          if(retiringTask && header?.task_id===retiringTask) {
            if(header.event==='task-finished'){retiringTask=null;run()}
            else if(header.event==='task-failed')finish('百炼未接受请求，请检查北京地域、模型权限、余额与密钥。')
            return
          }
          // Discard late control events from earlier tasks on a reused socket.
          if (!header || header.task_id !== taskId) return
          if (header.event === 'task-failed') return finish('百炼未接受请求，请检查北京地域、模型权限、余额与密钥。')
          if (header.event === 'task-started' && !started) {
            started = true; stats.prepareMs = performance.now() - start
            if (validateOnly && retainTask && sessionCache) finish()
            else if (validateOnly) send('finish-task', { input: { directive: 'cancel' } })
            else {
              submit()
            }
          } else if (header.event === 'task-finished') {
            if (!started || (!validateOnly && !bytes)) return finish('未收到有效音频，请稍后重试。')
            finish()
          }
        } catch { finish('语音流格式异常，试听已停止。') }
      })
      listen('error', () => finish('无法连接百炼，请检查网络以及北京地域 API Key。'))
      listen('close', () => finish('语音连接提前结束，请重试。'))
      if(prepared && !validateOnly && Date.now()-prepared.at<20000) {
        taskId=prepared.taskId;started=true;stats.reusedTask=true;stats.connectMs=0;stats.prepareMs=0;submit()
      }else if(prepared) {
        retiringTask=prepared.taskId
        socket.send(JSON.stringify({header:{action:'finish-task',task_id:retiringTask,streaming:'duplex'},payload:{input:{directive:'cancel'}}}))
      }else if (stats.reusedConnection) run()
    } catch { finish('语音连接未能建立。') }
  })
}
