import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const fault = (code) => Object.assign(new Error('Local chat relay failed'), { code })
export function blivechatConfig(env = process.env) {
  return {
    url: env.BILIBILI_RELAY_URL || 'ws://127.0.0.1:12451/api/chat',
    code: env.BILIBILI_ANCHOR_CODE?.trim(),
    roomId: env.BILIBILI_RELAY_ROOM_ID?.trim(),
  }
}
export function localRelayUrl(value) {
  try {
    const u = new URL(value)
    if (
      u.protocol === 'ws:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === '/api/chat'
    ) {
      if (u.hostname === 'localhost') u.hostname = '127.0.0.1'
      return u.href
    }
  } catch {}
  throw fault('configuration')
}
// Array positions are the published blivechat /api/chat protocol, checked at v1.10.4.
export function normalizeBlivechat(event, scope, now = Date.now()) {
  if (event?.cmd !== 2 || !Array.isArray(event.data) || event.data.length < 19) return null
  const d = event.data
  if (
    !Number.isFinite(d[1]) ||
    now - d[1] * 1000 > 20_000 ||
    d[1] * 1000 - now > 60_000 ||
    typeof d[4] !== 'string' ||
    !d[4].trim() ||
    d[4].length > 500 ||
    typeof d[2] !== 'string' ||
    d[2].length > 80 ||
    typeof d[16] !== 'string' ||
    !d[16] ||
    d[16].length > 128 ||
    typeof d[11] !== 'string' ||
    !d[11] ||
    d[11].length > 256 ||
    ![0, 1, 2, 3].includes(d[3]) ||
    d[6] !== 0 ||
    d[13] !== 0 ||
    d[18] !== 0
  )
    return null
  const text = d[4].trim()
  return {
    id: createHash('sha256')
      .update(JSON.stringify([scope, d[11]]))
      .digest('hex'),
    platform: 'bilibili',
    userId: d[16],
    displayName: d[2] || 'B站观众',
    text,
    real: true,
    mentioned: /小鲸鱼|大肥鱼|鲸鱼娘|助播/.test(text),
    selected: false,
    sourceAt: d[1] * 1000,
  }
}

export class BlivechatRelay {
  constructor({
    config = blivechatConfig(),
    WebSocketImpl = WebSocket,
    now = Date.now,
    onMessage = () => false,
    retryMs = 1000,
    timeoutMs = 25_000,
  } = {}) {
    Object.assign(this, { config, WebSocketImpl, now, onMessage, retryMs, timeoutMs })
    this.state = 'disconnected'
    this.error = null
    this.controller = null
    this.work = null
    this.received = 0
    this.accepted = 0
    this.dropped = 0
    this.retries = 0
    this.lastMessageAt = null
    this.windowAt = 0
    this.windowCount = 0
    this.scope = createHash('sha256')
      .update(config.code || config.roomId || '')
      .digest('hex')
  }
  status() {
    let valid = false
    try {
      localRelayUrl(this.config.url)
      valid = true
    } catch {}
    const codeValid = typeof this.config.code === 'string' && /^[\x21-\x7e]{1,256}$/.test(this.config.code)
    const roomValid =
      /^[1-9]\d{0,14}$/.test(this.config.roomId || '') && Number.isSafeInteger(Number(this.config.roomId))
    return {
      source: 'blivechat',
      configured: valid && (this.config.code ? codeValid : roomValid),
      missing: valid && (codeValid || roomValid) ? [] : ['本机 blivechat 和主播身份码（或房间号）'],
      state: this.state,
      error: this.error,
      roomId: this.config.code ? null : roomValid ? this.config.roomId : null,
      received: this.received,
      accepted: this.accepted,
      dropped: this.dropped,
      retries: this.retries,
      lastMessageAt: this.lastMessageAt,
      connectionScope: 'local-relay',
    }
  }
  start() {
    if (this.work) return this.status()
    if (!this.status().configured) {
      this.state = 'error'
      this.error = 'configuration'
      return this.status()
    }
    this.controller = new AbortController()
    this.state = 'connecting'
    this.error = null
    this.retries = 0
    this.work = this.run(this.controller.signal).finally(() => {
      this.work = null
      this.controller = null
    })
    return this.status()
  }
  async stop() {
    this.controller?.abort()
    await this.work
    this.state = 'disconnected'
    this.error = null
    return this.status()
  }
  async run(signal) {
    while (!signal.aborted) {
      this.state = 'connecting'
      try {
        await this.connect(signal)
      } catch (error) {
        if (!signal.aborted) {
          this.error = ['credentials', 'platform', 'protocol', 'timeout', 'configuration'].includes(
            error.code,
          )
            ? error.code
            : 'network'
        }
      }
      if (signal.aborted) break
      if (
        ['credentials', 'platform', 'protocol', 'configuration'].includes(this.error) ||
        ++this.retries >= 6
      ) {
        this.state = 'error'
        break
      }
      this.state = 'retrying'
      try {
        await delay(Math.min(30_000, this.retryMs * 2 ** (this.retries - 1)), null, { signal })
      } catch {
        break
      }
    }
  }
  connect(signal) {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(localRelayUrl(this.config.url))
      ws.binaryType = 'arraybuffer'
      let done = false,
        lastReceived = this.now()
      const finish = (error) => {
        if (done) return
        done = true
        clearInterval(timer)
        signal.removeEventListener('abort', abort)
        try {
          ws.close()
        } catch {}
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish()
      const timer = setInterval(
        () => {
          if (this.now() - lastReceived >= this.timeoutMs) finish(fault('timeout'))
        },
        Math.min(1000, this.timeoutMs),
      )
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        finish()
        return
      }
      ws.addEventListener('open', () => {
        if (done || signal.aborted) return
        try {
          const roomKey = this.config.code
            ? { type: 2, value: this.config.code }
            : { type: 1, value: Number(this.config.roomId) }
          ws.send(JSON.stringify({ cmd: 1, data: { roomKey, config: { autoTranslate: false } } }))
        } catch {
          finish(fault('network'))
        }
      })
      ws.addEventListener('error', () => finish(fault('network')))
      ws.addEventListener('close', () => finish(fault('network')))
      ws.addEventListener('message', (event) => {
        if (done || signal.aborted) return
        try {
          const bytes = typeof event.data === 'string' ? Buffer.from(event.data) : Buffer.from(event.data)
          if (bytes.length > 64 * 1024) throw fault('protocol')
          const message = JSON.parse(bytes.toString('utf8'))
          if (!message || !Number.isInteger(message.cmd)) throw fault('protocol')
          if (message.cmd === 8) throw fault(message.data?.type === 1 ? 'credentials' : 'platform')
          if (message.cmd === 0) {
            lastReceived = this.now()
            this.state = 'connected'
            this.error = null
            ws.send(JSON.stringify({ cmd: 0 }))
          } else if (message.cmd === 2) {
            lastReceived = this.now()
            this.state = 'connected'
            this.error = null
            this.receive(message)
          }
        } catch (error) {
          finish(fault(['credentials', 'platform'].includes(error.code) ? error.code : 'protocol'))
        }
      })
    })
  }
  receive(event) {
    this.received++
    this.lastMessageAt = this.now()
    const message = normalizeBlivechat(event, this.scope, this.now())
    if (this.now() - this.windowAt >= 1000) {
      this.windowAt = this.now()
      this.windowCount = 0
    }
    if (!message || ++this.windowCount > 30 || !this.onMessage(message)) {
      this.dropped++
      return
    }
    this.accepted++
  }
}
