import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Scheduler } from './scheduler.mjs'
import { Director } from './director.mjs'
import { streamReply } from './deepseek.mjs'

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function readBody(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16_384) throw new HttpError(413, '请求过大')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error()
    return body
  } catch { throw new HttpError(400, '需要 JSON 对象') }
}

function textField(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HttpError(400, `文本需为 1–${max} 个字符`)
  return value.trim()
}

function authorized(request, token) {
  if (!token) return true
  const actual = Buffer.from(request.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createApp({ apiKey = process.env.DEEPSEEK_API_KEY, model = process.env.DEEPSEEK_MODEL || 'deepseek-flash', token = process.env.COHOST_ACCESS_TOKEN || '', scheduler = new Scheduler(), director = new Director({ scheduler }), reply = streamReply } = {}) {
  const page = readFileSync(new URL('./index.html', import.meta.url))
  let history = []
  scheduler.onDelivered = (input, answer) => {
    history = [...history, { role: 'user', content: JSON.stringify(input) }, { role: 'assistant', content: answer }].slice(-12)
  }
  const server = createServer(async (request, response) => {
    try {
      const path = request.url?.split('?')[0]
      if (request.method === 'GET' && path === '/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        })
        response.end(page)
        return
      }
      if (path === '/healthz' && request.method === 'GET') { json(response, 200, { ok: true }); return }
      if (!path?.startsWith('/api/')) throw new HttpError(404, '未找到')
      if (!authorized(request, token)) throw new HttpError(401, '请填写正确的助播访问令牌')
      if (request.method === 'GET' && path === '/api/status') {
        json(response, 200, { ...scheduler.status(), director: director.status(), deepseekConfigured: Boolean(apiKey), model, stage: '文字与导演事件原型；尚未连接语音和 AIRI' })
        return
      }
      if (request.method !== 'POST') throw new HttpError(405, '请使用 POST')
      // JSON and no CORS support prevent cross-origin form submissions.
      if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '需要 application/json')
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不接受跨站请求')
      const body = await readBody(request)
      if (path === '/api/director/event') {
        const state = director.event(body)
        json(response, 200, { director: state, ...scheduler.status() })
        return
      }
      if (path === '/api/playback') {
        if (!Number.isSafeInteger(body.turn) || typeof body.audioId !== 'string' ||
          !['started', 'progress', 'ended', 'stopped', 'error'].includes(body.event) ||
          (body.event !== 'started' && (!Number.isInteger(body.playedChars) || body.playedChars < 0)))
          throw new HttpError(400, '无效播放反馈')
        json(response, 200, { accepted: scheduler.playbackEvent(body), ...scheduler.status() })
        return
      }
      if (path === '/api/host-speaking' || path === '/api/mute') {
        if (typeof body.value !== 'boolean') throw new HttpError(400, 'value 需要布尔值')
        director.reset(path === '/api/mute' ? 'manual_mute_changed' : 'manual_host_override')
        if (path === '/api/mute') scheduler.setMuted(body.value)
        else scheduler.setHostSpeaking(body.value)
        json(response, 200, scheduler.status())
        return
      }
      if (path === '/api/interrupt') {
        director.reset('manual_interrupt')
        scheduler.interrupt()
        json(response, 200, scheduler.status())
        return
      }
      if (path === '/api/reset') {
        director.reset('reset', { clearSpeech: true })
        scheduler.interrupt()
        scheduler.queue = []
        history = []
        json(response, 200, scheduler.status())
        return
      }
      if (path === '/api/danmaku') {
        if (!['bilibili', 'wechat', 'manual'].includes(body.platform)) throw new HttpError(400, '平台无效')
        const message = {
          id: textField(body.id, 128), platform: body.platform,
          userId: textField(body.userId, 128), text: textField(body.text, 500),
          mentioned: body.mentioned === true, selected: body.selected === true,
        }
        json(response, 200, { accepted: scheduler.enqueue(message), ...scheduler.status() })
        return
      }
      if (path !== '/api/reply') throw new HttpError(404, '未找到')
      if (!apiKey) throw new HttpError(503, '先在云环境网络密钥中配置 DEEPSEEK_API_KEY，再启动服务')
      if (!['host', 'viewer', 'director'].includes(body.source)) throw new HttpError(400, 'source 无效')
      if (body.delivery !== undefined && !['text', 'audio'].includes(body.delivery)) throw new HttpError(400, 'delivery 无效')
      if (body.source === 'director' && !Number.isSafeInteger(body.decision)) throw new HttpError(400, '需要 decision 编号')
      const text = body.source === 'host' ? textField(body.text) : null
      if (body.source !== 'director') director.invalidate('manual_reply')
      const turn = body.source === 'host' ? scheduler.beginHost(text) : body.source === 'director' ? director.consume(body.decision) : scheduler.beginViewer()
      if (!turn) throw new HttpError(409, '当前保持安静：主播在说话、已静音、正在回答、冷却中，或没有合适弹幕')
      turn.delivery = body.delivery ?? 'text'
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      const send = value => { if (!response.destroyed) response.write(`${JSON.stringify({ ...value, turn: turn.id, audioId: turn.audioId })}\n`) }
      const disconnected = () => {
        if (!response.writableEnded && scheduler.isCurrent(turn)) scheduler.interrupt()
      }
      response.on('close', disconnected)
      send({ type: 'start', turn: turn.id, source: turn.input.source })
      let completed = false
      try {
        for await (const chunk of reply({ apiKey, model, history: [...history], input: turn.input, signal: turn.controller.signal })) {
          if (!scheduler.isCurrent(turn)) break
          turn.answer += chunk
          send({ type: 'delta', text: chunk })
        }
        if (scheduler.isCurrent(turn)) {
          completed = true
          send({ type: 'done', awaitingPlayback: turn.delivery === 'audio' })
        } else send({ type: 'cancelled' })
      } catch (error) {
        if (turn.controller.signal.aborted) send({ type: 'cancelled' })
        else send({ type: 'error', message: error.name === 'TimeoutError' ? '模型响应超时，请稍后重试' : '模型调用失败，请检查服务端密钥、额度和网络' })
      } finally {
        if (completed) scheduler.finish(turn)
        else if (scheduler.isCurrent(turn)) scheduler.interrupt()
        response.end()
        response.off('close', disconnected)
      }
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : '服务内部错误' })
      else response.end()
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.on('close', () => director.close())
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.')
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (process.env.COHOST_ACCESS_TOKEN?.length ?? 0) < 24)
    throw new Error('Set COHOST_ACCESS_TOKEN (24+ characters) before binding beyond loopback.')
  const server = createApp()
  server.listen(port, host, () => console.log(`文字联调台 http://${host}:${port} — 尚未连接语音、AIRI 或真实弹幕`))
  const stop = () => { server.close(); server.closeAllConnections() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
