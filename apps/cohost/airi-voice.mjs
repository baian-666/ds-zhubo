import { randomUUID } from 'node:crypto'

function fail(status, message) { const error = new Error(message); error.status = status; throw error }
const stages = new Set(['desktop', 'web'])

/** One AIRI stage owns capture and playback. Closing its lease cancels all pending cloud requests. */
export class AiriVoice {
  constructor({ key = process.env.SILICONFLOW_API_KEY, fetchImpl = fetch, now = Date.now, onStop = () => {} } = {}) {
    this.key = key; this.fetch = fetchImpl; this.now = now; this.onStop = onStop
    this.stages = new Map(); this.session = null; this.error = ''; this.pending = new Set()
    this.lastText = ''; this.asrMs = null
  }
  snapshot() {
    return { configured: Boolean(this.key), active: Boolean(this.session), stage: this.session?.stage ?? null,
      control: this.session?.control ?? null, ready: Boolean(this.session?.ready), pending: this.pending.size,
      error: this.error, final: this.lastText, asrMs: this.asrMs,
      stages: [...this.stages.entries()].filter(([, state]) => this.now() - state.at < 3000).map(([stage, state]) => ({ stage, ready:state.ready })) }
  }
  pulse({ stage, owner, ready, listening = false }, activeTurn) {
    if (!stages.has(stage) || typeof owner !== 'string' || owner.length < 8 || owner.length > 100 || typeof ready !== 'boolean' || typeof listening !== 'boolean') fail(400, '无效舞台心跳')
    this.tick()
    this.stages.set(stage, {at:this.now(), ready})
    const session = this.session
    if (!session || session.stage !== stage || (session.owner && session.owner !== owner)) return {run:null}
    if (!session.owner) session.owner = owner
    session.at = this.now(); session.ready = ready && listening
    return {run:session.id, turn:activeTurn?.airiRun === session.id && !activeTurn.controller.signal.aborted
      ? {id:activeTurn.id, audioId:activeTurn.audioId, text:activeTurn.answer, done:activeTurn.generationDone} : null}
  }
  start(stage, control) {
    this.tick()
    if (!this.key) fail(503, '请先配置云端语音账号并重启联调台')
    if (this.session) fail(409, '已有舞台正在收音，请先停止')
    if (!stages.has(stage) || !this.stages.get(stage)?.ready || this.now() - this.stages.get(stage).at > 3000) fail(409, '所选 AIRI 舞台尚未连接，请先打开舞台')
    this.error = ''; this.lastText = ''; this.asrMs = null
    this.session = {id:randomUUID(), stage, control, owner:null, ready:false, at:this.now()}
    return this.snapshot()
  }
  authenticate(request) {
    this.tick()
    if (!this.session?.owner || request.headers.authorization !== 'Bearer ' + this.session.id + ':' + this.session.owner) fail(409, '语音会话已失效')
    return this.session
  }
  stop(error = '') {
    if (!this.session) return
    this.session = null; this.error = error
    for (const controller of this.pending) controller.abort()
    this.pending.clear()
    this.onStop()
  }
  tick() { if (this.session && this.now() - this.session.at > 3500) this.stop('舞台连接已断开，收音已停止') }
  cancelRequests() { for (const controller of this.pending) controller.abort() }

  async cloud(path, body, { signal, turnSignal } = {}) {
    const run = this.session?.id
    if (!run) fail(409, '语音会话已停止')
    if (this.pending.size >= 5) fail(429, '语音请求过多，请等待')
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted || turnSignal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, {once:true}); turnSignal?.addEventListener('abort', abort, {once:true})
    this.pending.add(controller)
    const timer = setTimeout(abort, 30000)
    const started = this.now()
    try {
      const response = await this.fetch('https://api.siliconflow.cn/v1/audio/' + path, {
        method:'POST', headers:{Authorization:'Bearer ' + this.key, ...(path === 'speech' ? {'Content-Type':'application/json'} : {})},
        body, signal:controller.signal, redirect:'error' })
      if (!response.ok) { await response.body?.cancel(); fail(502, '云端语音调用失败，请检查账号额度和网络') }
      const result = path === 'speech' ? Buffer.from(await response.arrayBuffer()) : await response.json()
      if (controller.signal.aborted || this.session?.id !== run) fail(409, '已丢弃过期语音结果')
      if (path === 'transcriptions') {
        this.asrMs = this.now() - started
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
      clearTimeout(timer); this.pending.delete(controller)
      signal?.removeEventListener('abort',abort); turnSignal?.removeEventListener('abort',abort)
    }
  }
}
