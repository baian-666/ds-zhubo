import { randomUUID } from 'node:crypto'
import { keyValid } from './qwen-credential.mjs'
export { keyValid } from './qwen-credential.mjs'

export const MODEL = 'qwen3-tts-flash-realtime'
export const VOICES = ['Cherry', 'Serena', 'Chelsie', 'Momo', 'Vivian']
export const CLONE_MODELS = ['qwen3-tts-vc-realtime-2026-01-15', 'qwen3-tts-vc-realtime-2025-11-27']
export const unavailableModelMessage = '百炼暂未提供所选语音模型，请检查模型名称、北京地域及账号模型权限；原声音配置已保留。'
export function validQwenVoice(model, voice) {
  return model === MODEL ? VOICES.includes(voice)
    : CLONE_MODELS.includes(model) && typeof voice === 'string' && /^qwen-tts-vc-[A-Za-z0-9_-]{1,180}$/.test(voice)
}

const safeMessages = new Set(['请先配置百炼 API Key。', '请选择音色，输入 1–300 字的台词。', '试听已停止。', '语音请求超时，请稍后重试。', '语音连接已中断。', '百炼未接受请求，请检查北京地域、模型权限、余额与密钥。', '试听音频超出长度限制。', '未收到有效音频，请稍后重试。', '语音流格式异常，试听已停止。', '无法连接百炼，请检查网络以及北京地域 API Key。', '语音连接提前结束，请重试。', '语音连接未能建立。'])
export const qwenFailureMessage = error => safeMessages.has(error?.message) ? error.message : '百炼连接失败，请检查网络和账号配置。'
safeMessages.add(unavailableModelMessage)

export function createQwenSessionCache({ idleMs = 120000, maxIdle = 1 } = {}) {
  if(!Number.isInteger(maxIdle)||maxIdle<1||maxIdle>2)throw Error('Qwen cache supports one or two idle connections')
  const stored=[]
  const remove = item => {
    const index=stored.indexOf(item)
    if(index>=0)stored.splice(index,1)
    clearTimeout(item.timer)
    try { item.socket.close() } catch {}
  }
  const clear = (accept=()=>true) => {
    for(const item of [...stored])if(accept(item.socket))remove(item)
  }
  return {
    available(maxAgeMs=Infinity,accept=()=>true) {
      for(const item of [...stored])if(item.socket.readyState!==1 || Date.now()>=item.expiresAt)remove(item)
      // Age requests a replacement. Keep live sockets usable until a replacement arrives.
      return stored.filter(item=>Date.now()-item.at<maxAgeMs && accept(item.socket)).length
    },
    take(key, voice, model = MODEL, accept=()=>true) {
      if(stored.some(item=>item.key!==key||item.voice!==voice||item.model!==model)){clear();return}
      for(const item of [...stored].reverse()) {
        if(item.socket.readyState!==1 || Date.now()>=item.expiresAt){remove(item);continue}
        if(!accept(item.socket))continue
        stored.splice(stored.indexOf(item),1);clearTimeout(item.timer)
        return item.socket
      }
    },
    put(socket, key, voice, model = MODEL, validForMs=idleMs) {
      if (socket.readyState !== 1) return
      if(stored.some(item=>item.key!==key||item.voice!==voice||item.model!==model))clear()
      while(stored.length>=maxIdle)remove(stored[0])
      const ttl=Math.min(idleMs,validForMs)
      const item={socket,key,voice,model,timer:null,at:Date.now(),expiresAt:Date.now()+ttl}
      stored.push(item)
      item.timer=setTimeout(()=>remove(item),ttl);item.timer.unref?.()
    },
    clear,
  }
}

// Node 26's WebSocketInit supports server-side Authorization headers. Never put
// credentials in a URL or send provider errors/raw session objects to the browser.
export function streamQwen({ key, text = '', voice = 'Cherry', model = MODEL, validateOnly = false,
  signal, onEvent = () => {}, WebSocketImpl = WebSocket, timeoutMs = 45000, sessionCache } = {}) {
  if (!keyValid(key)) return Promise.reject(new Error('请先配置百炼 API Key。'))
  if (!validQwenVoice(model, voice) || (!validateOnly && (typeof text !== 'string' || !text.trim() || text.length > 300)))
    return Promise.reject(new Error('请选择音色，输入 1–300 字的台词。'))
  if (signal?.aborted) return Promise.reject(new Error('试听已停止。'))
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let socket, settled = false, submitted = null, sent = false, bytes = 0, chunks = 0
    const stats = { model, voice, sampleRate: 24000, reusedConnection: false, connectMs: null, prepareMs: null, firstPcmMs: null, synthesisFirstPcmMs: null }
    const listeners = []
    const listen = (type, handler) => { listeners.push([type, handler]); socket.addEventListener(type, handler) }
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      for (const [type, handler] of listeners) socket?.removeEventListener(type, handler)
      if (!error && sessionCache && socket?.readyState === 1) sessionCache.put(socket, key, voice, model)
      else { try { socket?.close() } catch {} }
      if (error) reject(new Error(error))
      else resolve({ ...stats, chunks, audioSeconds: bytes / 48000, totalMs: performance.now() - start })
    }
    const abort = () => finish('试听已停止。')
    const timer = setTimeout(() => finish('语音请求超时，请稍后重试。'), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    const send = (type, data = {}) => socket.send(JSON.stringify({ event_id: randomUUID(), type, ...data }))
    const submit = () => {
      sent = true
      stats.prepareMs = performance.now() - start
      if (validateOnly) return finish()
      submitted = performance.now()
      onEvent({ type: 'ready', connectMs: stats.connectMs, prepareMs: stats.prepareMs, reusedConnection: stats.reusedConnection })
      send('input_text_buffer.append', { text: text.trim() })
      send('input_text_buffer.commit')
    }
    try {
      socket = sessionCache?.take(key, voice, model)
      stats.reusedConnection = Boolean(socket)
      socket ??= new WebSocketImpl('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=' + model,
        { headers: { Authorization: 'Bearer ' + key } })
      listen('open', () => {
        if (settled) return
        stats.connectMs = performance.now() - start
        try { send('session.update', { session: { voice, mode: 'commit', language_type: 'Chinese', response_format: 'pcm', sample_rate: 24000 } }) }
        catch { finish('语音连接已中断。') }
      })
      listen('message', event => {
        if (settled) return
        try {
          if (typeof event.data !== 'string' || event.data.length > 2_000_000) throw new Error()
          const data = JSON.parse(event.data)
          if (data.type === 'error') return finish('百炼未接受请求，请检查北京地域、模型权限、余额与密钥。')
          if (data.type === 'session.updated' && !sent) {
            submit()
          } else if (data.type === 'response.audio.delta') {
            if (!sent || submitted === null || typeof data.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.delta)) throw new Error()
            const pcm = Buffer.from(data.delta, 'base64')
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
          } else if (data.type === 'response.done') {
            if (data.response?.status === 'failed' || !bytes) return finish('未收到有效音频，请稍后重试。')
            finish()
          }
        } catch { finish('语音流格式异常，试听已停止。') }
      })
      listen('error', () => finish('无法连接百炼，请检查网络以及北京地域 API Key。'))
      listen('close', event => { if (!settled) finish(event.code === 1007 && /Model not (exist|found)/i.test(event.reason || '') ? unavailableModelMessage : '语音连接提前结束，请重试。') })
      if (stats.reusedConnection) { stats.connectMs = 0; submit() }
    } catch { finish('语音连接未能建立。') }
  })
}
