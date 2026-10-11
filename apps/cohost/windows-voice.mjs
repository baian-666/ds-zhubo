import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// One owner leases the microphone. Worker generations and prompt IDs reject late events.
// No raw microphone audio is persisted or sent to a recognition service.
export class WindowsVoice {
  constructor({ onSpeech = () => {}, onPlayback = () => {}, onStop = () => {}, now = Date.now,
    supported = process.platform === 'win32', launch = () => spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../../scripts/windows-speech.ps1', import.meta.url)), '-Mode', 'live'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['DEEPSEEK_API_KEY','COHOST_ACCESS_TOKEN'].includes(key))) }) } = {}) {
    Object.assign(this, { onSpeech, onPlayback, onStop, now, supported, launch })
    this.worker = null; this.owner = null; this.ready = false; this.output = false
    this.partial = ''; this.final = ''; this.level = 0; this.error = ''; this.voice = ''; this.uncertain = ''
    this.prompt = null; this.utterance = null; this.serial = 0; this.lastNativeUtterance = 0
  }
  snapshot() {
    return { available: this.supported, active: Boolean(this.worker), owner: this.owner, ready: this.ready,
      output: this.output, partial: this.partial, final: this.final, level: this.level, error: this.error,
      voice: this.voice, uncertain: this.uncertain, speaking: Boolean(this.prompt), lastFinalAt: this.lastFinalAt ?? null }
  }
  start(owner, output) {
    if (!this.supported) throw Object.assign(new Error('此语音入口需要 Windows 中文语音组件'), { status: 503 })
    if (this.worker) {
      if (this.owner !== owner) throw Object.assign(new Error('另一页正在收音，请先在那一页停止'), { status: 409 })
      this.heartbeat(owner); return this.snapshot()
    }
    Object.assign(this, { owner, output, ready: false, partial: '', final: '', uncertain: '', error: '', level: 0, prompt: null, utterance: null, lastNativeUtterance: 0, lease: this.now(), startedAt:this.now() })
    const worker = this.launch()
    this.worker = worker
    const lines = createInterface({ input: worker.stdout })
    lines.on('line', line => {
      if (this.worker !== worker) return
      try { this.receive(JSON.parse(line)) } catch { this.fail('语音组件数据异常，请重新开启收音') }
    })
    worker.stdin.on('error', () => { if (this.worker === worker) this.fail('语音组件连接中断') })
    worker.stderr.on('data', () => { this.workerError = true })
    worker.on('error', () => { if (this.worker === worker) this.fail('无法启动 Windows 语音组件') })
    worker.on('exit', () => { lines.close(); if (this.worker === worker) this.fail('语音组件已退出，请检查默认麦克风和中文语音组件') })
    return this.snapshot()
  }
  heartbeat(owner) {
    if (this.worker && owner !== this.owner) throw Object.assign(new Error('当前收音由另一页控制'), { status: 409 })
    this.lease = this.now()
    return this.snapshot()
  }
  send(command) {
    if (this.worker?.stdin.writable) this.worker.stdin.write(JSON.stringify(command) + '\n')
  }
  tick() {
    if (this.worker && !this.ready && this.now() - this.startedAt > 15000) this.stop('中文识别启动超时，请检查 Windows 语音组件')
    if (this.worker && this.now() - this.lease > 8000) this.stop('页面连接断开，已停止收音')
    if (this.utterance && this.now() - this.utteranceAt > 15000) this.endUtterance()
  }
  stop(message = '') {
    const worker = this.worker
    this.worker = null; this.ready = false; this.owner = null; this.level = 0; this.partial = ''
    this.prompt = null; this.utterance = null
    this.error = message
    if (worker) {
      worker.stdin.end(JSON.stringify({ action: 'stop' }) + '\n')
      const timer = setTimeout(() => { if (worker.exitCode === null) worker.kill() }, 1500); timer.unref()
      this.onStop()
    }
    return this.snapshot()
  }
  fail(message) { this.stop(message) }
  endUtterance() {
    if (this.utterance) this.onSpeech({ type: 'speech-end', utterance: this.utterance })
    this.utterance = null; this.partial = ''
  }
  receive(event) {
    if (event.type === 'ready') { this.ready = true; this.voice = event.voice; return }
    if (['error', 'input-ended'].includes(event.type)) { this.fail('中文识别不可用或输入已结束，请检查 Windows 默认麦克风'); return }
    if (event.type === 'level') { this.level = Math.min(100, Math.max(0, Number(event.level) || 0)); return }
    if (event.type === 'speech-start') {
      this.endUtterance()
      this.lastNativeUtterance = event.utterance
      this.utterance = Math.max(this.now(), this.serial + 1); this.serial = this.utterance
      this.utteranceAt = this.now(); this.partial = ''; this.uncertain = ''
      this.onSpeech({ type: 'speech-start', utterance: this.utterance })
      return
    }
    if (['partial', 'final', 'rejected'].includes(event.type)) {
      if (!this.utterance || event.utterance !== this.lastNativeUtterance) return
      this.utteranceAt = this.now()
      if (event.type === 'rejected') { this.endUtterance(); return }
      const text = typeof event.text === 'string' ? event.text.trim().slice(0, 2000) : ''
      this.partial = text
      if (event.type === 'final') {
        if (text && event.confidence >= 0.25) {
          this.uncertain = ''; this.final = text; this.lastFinalAt = this.now()
          this.onSpeech({ type: 'transcript', utterance: this.utterance, text, final: true })
        } else if (text) this.uncertain = text
        this.endUtterance()
      }
      return
    }
    const prompt = this.prompt
    if (!prompt || event.id !== prompt.id) return
    const kind = { 'playback-start': 'started', 'playback-progress': 'progress', 'playback-end': 'ended',
      'playback-cancelled': 'stopped', 'playback-error': 'error' }[event.type]
    if (!kind) return
    let playedChars = kind === 'ended' ? prompt.text.length : prompt.played
    if (kind === 'progress' && Number.isInteger(event.playedChars)) {
      playedChars = Math.max(prompt.played, Math.min(event.playedChars, prompt.text.length))
      if (playedChars > 0 && /[\uD800-\uDBFF]/u.test(prompt.text[playedChars - 1]) && /[\uDC00-\uDFFF]/u.test(prompt.text[playedChars] ?? '')) playedChars--
    }
    prompt.played = playedChars
    // Clear first because the scheduler abort callback also cancels the native prompt.
    if (['ended', 'stopped', 'error'].includes(kind)) this.prompt = null
    const accepted = this.onPlayback({ turn: prompt.turn, audioId: prompt.audioId, event: kind, playedChars })
    if (accepted === false && this.prompt === prompt) this.cancel(prompt.turn)
  }
  speak(turn) {
    if (!this.ready || !this.output || !turn.answer) return false
    this.cancel()
    this.prompt = { id: String(++this.serial), turn: turn.id, audioId: turn.audioId, text: turn.answer, played: 0 }
    this.send({ action: 'speak', id: this.prompt.id, text: turn.answer })
    return true
  }
  cancel(turn) {
    if (turn !== undefined && this.prompt?.turn !== turn) return
    this.prompt = null
    this.send({ action: 'cancel' })
  }
}
