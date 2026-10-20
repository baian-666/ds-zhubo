import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const failure = (message, status = 502) => Object.assign(new Error(message), { status })

/** Opt-in local streaming candidate. One worker owns the model, each VAD segment
 * owns a separate decoder. No microphone, network access, or expected text here. */
export class LocalStreamingAsr {
  constructor({ python = process.env.LOCAL_ASR_PYTHON || 'python',
    modelDir = fileURLToPath(new URL('../../data/asr-local/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01',import.meta.url)),
    runtimeDir = fileURLToPath(new URL('../../data/asr-local/runtime',import.meta.url)), spawnImpl = spawn } = {}) {
    this.python = python; this.modelDir = modelDir; this.runtimeDir = runtimeDir; this.spawn = spawnImpl
    this.segments = new Map()
  }
  available() {
    return existsSync(resolve(this.modelDir,'model.int8.onnx')) && existsSync(resolve(this.modelDir,'tokens.txt')) &&
      existsSync(resolve(this.runtimeDir,'sherpa_onnx'))
  }
  prepare(signal) {
    if (signal?.aborted) return Promise.reject(failure('识别准备已取消', 409))
    if (!this.child) {
      let child
      this.ready = new Promise((resolveReady, rejectReady) => { this.resolveReady = resolveReady; this.rejectReady = rejectReady })
      this.ready.catch(() => {})
      this.loaded = false; this.pending = ''
      try {
        child = this.spawn(this.python, ['-X', 'utf8', '-u', fileURLToPath(new URL('../../scripts/local-streaming-asr.py', import.meta.url)),
          '--model-dir', resolve(this.modelDir), '--runtime-dir', resolve(this.runtimeDir)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        this.child = child
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', value => {
          if (this.child !== child) return
          this.pending += value
          if (this.pending.length > 128000) return this.clear(failure('本地识别输出积压'))
          let end
          while ((end = this.pending.indexOf('\n')) >= 0) {
            const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1)
            try { this.receive(JSON.parse(line)) } catch { this.clear(failure('本地识别返回无效数据')); return }
          }
        })
        // Drain diagnostics without placing arbitrary provider output in logs.
        child.stderr.resume()
        child.stdin.on('error', () => { if (this.child === child) this.clear(failure('本地识别输入已断开')) })
        child.once('error', () => { if (this.child === child) this.clear(failure('本地识别进程无法启动')) })
        child.once('exit', () => { if (this.child === child) this.clear(failure('本地识别进程已退出')) })
        this.startTimer = setTimeout(() => this.clear(failure('本地识别加载超时', 504)), 20000)
      } catch { this.clear(failure('本地识别配置无效', 503)) }
    }
    const cancel = () => this.clear(failure('识别准备已取消', 409))
    signal?.addEventListener('abort', cancel, { once: true })
    return this.ready.finally(() => signal?.removeEventListener('abort', cancel))
  }
  send(message) {
    if (!this.child?.stdin.writable || this.child.stdin.writableLength > 256000) throw failure('本地识别输入积压', 429)
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  receive(event) {
    if (event.type === 'ready') { this.loaded = true; clearTimeout(this.startTimer); this.resolveReady(); return }
    const segment = this.segments.get(event.id)
    if (!segment) return
    if (event.type === 'error') { segment.close(failure('本地识别片段失败')); return }
    if (typeof event.text !== 'string' || event.text.length > 2000 || !['partial', 'final'].includes(event.type)) throw Error('Invalid decoder output')
    if (event.type === 'partial' && segment.state === 'sending') segment.emit({ type: 'partial', text: event.text, confirmed: '' })
    if (event.type === 'final' && segment.state === 'finishing') {
      const result = { text: event.text.trim(), asrMs: Date.now() - segment.finishedAt }
      segment.emit({ type: 'partial', text: result.text, confirmed: result.text })
      segment.emit({ type: 'final', ...result }); segment.resolve(result); segment.close()
    }
  }
  open(options) {
    if (!this.loaded) throw failure('本地识别尚未就绪', 409)
    if (this.segments.size >= 3) throw failure('本地识别片段积压', 429)
    return new LocalSegment(this, options)
  }
  clear(error = failure('本地识别已停止', 409)) {
    this.loaded = false; clearTimeout(this.startTimer); this.rejectReady?.(error)
    for (const segment of [...this.segments.values()]) segment.close(error)
    const child = this.child; this.child = null
    child?.stdin.end(); child?.kill()
  }
}

class LocalSegment {
  constructor(pool, { emit = () => {}, signal } = {}) {
    this.pool = pool; this.emit = emit; this.signal = signal; this.id = randomUUID()
    this.sequence = 0; this.bytes = 0; this.state = 'sending'
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject }); this.done.catch(() => {})
    this.ready = Promise.resolve()
    this.abort = () => this.close(failure('识别已取消', 409))
    if (signal?.aborted) { this.abort(); return }
    signal?.addEventListener('abort', this.abort, { once: true })
    this.timer = setTimeout(() => this.close(failure('本地识别片段过长', 504)), 70000)
    pool.segments.set(this.id, this)
    try {
      pool.send({ type: 'open', id: this.id })
      // The HTTP relay must write NDJSON headers before its first body frame.
      // Match the asynchronous ready event of a network ASR task.
      queueMicrotask(() => { if (this.state === 'sending') emit({ type: 'ready' }) })
    } catch (error) { this.close(error); throw error }
  }
  write(pcm, sequence) {
    if (this.state !== 'sending') throw failure('识别会话已结束', 409)
    if (sequence !== this.sequence || !Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length % 2 || pcm.length > 16384) throw failure('识别音频分片无效或乱序', 400)
    if (this.bytes + pcm.length > 1760000) throw failure('识别音频过长', 429)
    this.pool.send({ type: 'audio', id: this.id, pcm: pcm.toString('base64') })
    this.bytes += pcm.length; this.sequence++
  }
  finish(sequence) {
    if (this.state !== 'sending' || sequence !== this.sequence) throw failure('识别结束顺序无效', 409)
    this.state = 'finishing'; this.finishedAt = Date.now(); clearTimeout(this.timer)
    this.timer = setTimeout(() => this.close(failure('本地识别收尾超时', 504)), 2000)
    this.pool.send({ type: 'finish', id: this.id })
    return this.done
  }
  close(error) {
    if (this.state === 'closed') return
    this.state = 'closed'; clearTimeout(this.timer); this.signal?.removeEventListener('abort', this.abort)
    this.pool.segments.delete(this.id)
    try { this.pool.send({ type: 'cancel', id: this.id }) } catch {}
    if (error) this.reject(error)
    else this.resolve({ text: '', asrMs: 0 })
  }
}
