import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Scheduler } from './scheduler.mjs'
import { Director } from './director.mjs'
import { streamReply } from './deepseek.mjs'
import { mockReply } from './mock.mjs'
import { RoomJournal } from './room-journal.mjs'

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
  const histories = { deepseek: [], mock: [] }
  const room = new RoomJournal()
  director.onRecord = entry => {
    const previous = room.entries.at(-1)
    // The transcript and speech-end can repeat one rule decision; show one explanation.
    if (previous?.role === 'director' && previous.reason === entry.reason &&
      previous.action === entry.action && previous.directorRevision === entry.revision) return
    room.add('director', '', { action: entry.action, reason: entry.reason, traceId: entry.id,
      directorRevision: entry.revision, at: entry.at })
  }
  director.onTranscript = ({ text, utterance }) => room.host(text, utterance)
  scheduler.onDelivered = (input, answer) => {
    const engine = input.engine ?? 'deepseek'
    histories[engine] = [...histories[engine], { role: 'user', content: JSON.stringify(input) }, { role: 'assistant', content: answer }].slice(-12)
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
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src http://127.0.0.1:5173; frame-ancestors 'none'; base-uri 'none'",
        })
        response.end(page)
        return
      }
      if (request.method === 'GET' && path === '/client.mjs') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(readFileSync(new URL('./client.mjs', import.meta.url)))
        return
      }
      if (path === '/healthz' && request.method === 'GET') { json(response, 200, { ok: true }); return }
      if (!path?.startsWith('/api/')) throw new HttpError(404, '未找到')
      if (!authorized(request, token)) throw new HttpError(401, '请填写正确的助播访问令牌')
      if (request.method === 'GET' && path === '/api/status') {
        json(response, 200, { ...scheduler.status(), director: director.status(), deepseekConfigured: Boolean(apiKey), model, room: room.status(), queue: scheduler.queue.map(({id,platform,userId,text,mentioned,selected,receivedAt}) => ({id,platform,userId,text,mentioned,selected,expiresAt:receivedAt + scheduler.ttlMs})), stage: '本机文字虚拟直播间；AIRI 网页舞台嵌入，语音尚未连接' })
        return
      }
      if (request.method !== 'POST') throw new HttpError(405, '请使用 POST')
      // JSON and no CORS support prevent cross-origin form submissions.
      if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '需要 application/json')
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不接受跨站请求')
      const body = await readBody(request)
      if (path === '/api/director/event') {
        const state = director.event(body)
        if (body.type === 'speech-end' && director.mode === 'manual' && director.utterance?.id === body.utterance &&
          director.utterance.final && !['stop', 'backchannel'].includes(director.intent) &&
          !room.entries.some(x => x.reason === 'manual_wait' && x.utterance === body.utterance))
          room.add('director', '', { action: 'hold', reason: 'manual_wait', utterance: body.utterance })
        json(response, 200, { director: state, ...scheduler.status(), room: room.status() })
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
        room.clear()
        director.reset('reset', { clearSpeech: true })
        scheduler.interrupt()
        scheduler.queue = []
        histories.deepseek = []; histories.mock = []
        json(response, 200, scheduler.status())
        return
      }
      if (path === '/api/danmaku/select') {
        if (!['bilibili', 'wechat', 'manual'].includes(body.platform)) throw new HttpError(400, '平台无效')
        const accepted = scheduler.selectViewer(body.platform, textField(body.id, 128))
        if (!accepted) throw new HttpError(409, '弹幕已经过期或被消费')
        director.invalidate('viewer_selected')
        json(response, 200, { accepted, ...scheduler.status() })
        return
      }
      if (path === '/api/danmaku') {
        if (!['bilibili', 'wechat', 'manual'].includes(body.platform)) throw new HttpError(400, '平台无效')
        const message = {
          id: textField(body.id, 128), platform: body.platform,
          userId: textField(body.userId, 128), text: textField(body.text, 500),
          mentioned: body.mentioned === true, selected: body.selected === true,
        }
        const accepted = scheduler.enqueue(message)
        if (accepted) {
          room.add('viewer', message.text, { userId: message.userId, platform: message.platform, messageId: message.id })
          const reason = director.mode === 'manual' ? 'viewer_manual_wait' :
            !director.viewerWindow ? 'viewer_window_closed' :
            scheduler.hostSpeaking ? 'viewer_host_speaking' :
            scheduler.active ? 'viewer_busy' :
            !scheduler.peekViewer() ? 'viewer_ineligible' : null
          if (reason) room.add('director', '', { action: 'hold', reason })
        }
        json(response, 200, { accepted, ...scheduler.status(), room: room.status() })
        return
      }
      if (path !== '/api/reply') throw new HttpError(404, '未找到')
      const engine = body.engine ?? 'deepseek'
      if (!['deepseek', 'mock'].includes(engine)) throw new HttpError(400, 'engine 无效')
      if (engine === 'deepseek' && !apiKey) throw new HttpError(503, '请在本机忽略的 .env 配置 DEEPSEEK_API_KEY 并重启，或选择模拟回复')
      if (engine === 'mock' && body.delivery === 'audio') throw new HttpError(400, '模拟回复仅支持文字')
      if (!['host', 'viewer', 'director'].includes(body.source)) throw new HttpError(400, 'source 无效')
      if (body.delivery !== undefined && !['text', 'audio'].includes(body.delivery)) throw new HttpError(400, 'delivery 无效')
      if (body.source === 'director' && !Number.isSafeInteger(body.decision)) throw new HttpError(400, '需要 decision 编号')
      const text = body.source === 'host' ? textField(body.text) : null
      if (body.source === 'host') room.host(text, director.utterance?.final && director.utterance.text === text ? director.utterance.id : null)
      if (body.source !== 'director') director.invalidate('manual_reply')
      const turn = body.source === 'host' ? scheduler.beginHost(text) : body.source === 'director' ? director.consume(body.decision) : scheduler.beginViewer()
      if (!turn) throw new HttpError(409, '当前保持安静：主播在说话、已静音、正在回答、冷却中，或没有合适弹幕')
      turn.input.engine = engine
      turn.delivery = body.delivery ?? 'text'
      const answerSession = room.session
      const generatedAt = Date.now()
      const answerEntry = room.add('assistant', '', { turn: turn.id, engine, model: engine === 'mock' ? '模拟回复' : model,
        source: turn.input.source, replyingTo: turn.input.text, status: 'generating', firstMs: null })
      const updateAnswer = fields => room.update(answerEntry, fields)
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      const send = value => { if (!response.destroyed) response.write(`${JSON.stringify({ ...value, turn: turn.id, audioId: turn.audioId })}\n`) }
      const disconnected = () => {
        if (!response.writableEnded && scheduler.isCurrent(turn)) scheduler.interrupt()
        if (!response.writableEnded) updateAnswer({ status: 'cancelled' })
      }
      response.on('close', disconnected)
      send({ type: 'start', engine, model: engine === 'mock' ? '模拟回复' : model, turn: turn.id, source: turn.input.source, entry: { ...answerEntry }, session: answerSession })
      let completed = false
      try {
        for await (const chunk of (engine === 'mock' ? mockReply : reply)({ apiKey, model, history: [...histories[engine]], input: turn.input, signal: turn.controller.signal })) {
          if (!scheduler.isCurrent(turn)) break
          turn.answer += chunk
          updateAnswer({ text: turn.answer, firstMs: answerEntry.firstMs ?? Date.now() - generatedAt })
          send({ type: 'delta', text: chunk, entry: { ...answerEntry }, session: answerSession })
        }
        if (scheduler.isCurrent(turn)) {
          completed = true
          updateAnswer({ status: turn.delivery === 'audio' ? 'awaitingPlayback' : 'completed' })
          send({ type: 'done', awaitingPlayback: turn.delivery === 'audio', entry: { ...answerEntry }, session: answerSession })
        } else {
          updateAnswer({ status: 'cancelled' })
          send({ type: 'cancelled', entry: { ...answerEntry }, session: answerSession })
        }
      } catch (error) {
        const message = error.name === 'TimeoutError' ? '模型响应超时，请稍后重试' : '模型调用失败，请检查服务端密钥、额度和网络'
        updateAnswer({ status: turn.controller.signal.aborted ? 'cancelled' : 'failed', error: turn.controller.signal.aborted ? undefined : message })
        send({ type: turn.controller.signal.aborted ? 'cancelled' : 'error', message, entry: { ...answerEntry }, session: answerSession })
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
  server.listen(port, host, () => console.log(`文字联调台 http://${host}:${port} — 本机网页版虚拟直播间 · 语音与真实弹幕尚未接入`))
  const stop = () => { server.close(); server.closeAllConnections() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
