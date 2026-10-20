import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { saveVoiceKey } from './configure-voice.mjs'
import { streamQwen, keyValid, qwenFailureMessage, createQwenSessionCache } from './qwen-realtime-client.mjs'
import { normalizeQwenKey, qwenKeyIssue } from './qwen-credential.mjs'

const root = new URL('../', import.meta.url)
export function createQwenAudition({ envPath = fileURLToPath(new URL('.env', root)), stream = streamQwen } = {}) {
  const token = randomBytes(24).toString('base64url')
  const sessionCache = createQwenSessionCache()
  let active = false
  const key = () => existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')).DASHSCOPE_API_KEY : undefined
  const server = createServer(async (req, res) => {
    const host = '127.0.0.1:' + server.address().port
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== host) return reply(403, { message: '只接受本机访问。' })
    if (req.method === 'GET' && ['/', '/qwen-audition-browser.mjs'].includes(req.url)) {
      const html = req.url === '/'
      let body = readFileSync(new URL(html ? 'qwen-audition.html' : 'qwen-audition-browser.mjs', import.meta.url), 'utf8')
      if (html) body = body.replace('__CSRF_TOKEN__', token)
      res.writeHead(200, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" })
      return res.end(body)
    }
    if (req.method === 'GET' && req.url === '/status') {
      try { return reply(200, { configured: keyValid(key()) }) } catch { return reply(500, { message: '无法读取本机配置。' }) }
    }
    if (req.method !== 'POST' || !['/save', '/prepare', '/trial'].includes(req.url)) return reply(404, { message: '未找到。' })
    if (req.headers.origin !== 'http://' + host || req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-setup-token'] !== token || req.headers['content-type'] !== 'application/json')
      return reply(403, { message: '请从本机试听页操作。' })
    if (active) return reply(409, { message: '正在处理，请先停止当前试听。' })
    active = true
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    try {
      let size = 0
      const chunks = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > 4096) return reply(413, { message: '请求过大。' })
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(400, { message: '请求格式错误。' }) }
      if (req.url === '/save') {
        const credential = normalizeQwenKey(body?.key)
        const issue = qwenKeyIssue(credential)
        if (issue) return reply(400, { message: issue })
        try { await stream({ key: credential, validateOnly: true, signal: controller.signal, sessionCache }) }
        catch (error) { return reply(502, { message: qwenFailureMessage(error) + ' 密钥未保存。' }) }
        try { saveVoiceKey(envPath, credential, 'DASHSCOPE_API_KEY') }
        catch { return reply(500, { message: '百炼连接成功，但本机 .env 写入失败，请检查文件权限。' }) }
        return reply(200, { message: '已连接百炼并保存到本机，可以试听了。' })
      }
      const credential = key()
      if (!keyValid(credential)) return reply(400, { message: '请先保存百炼 API Key。' })
      if (req.url === '/prepare') {
        try {
          await stream({ key: credential, voice: body?.voice, validateOnly: true, signal: controller.signal, sessionCache })
          return reply(200, { message: '连接已就绪，可以直接试听。闲置两分钟后会自动释放。' })
        } catch (error) { return reply(502, { message: qwenFailureMessage(error) }) }
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.flushHeaders()
      const emit = event => {
        if (res.destroyed) return
        if (res.writableLength > 1_000_000) { controller.abort(); return }
        res.write(JSON.stringify(event) + '\n')
      }
      try {
        const result = await stream({ key: credential, text: body.text, voice: body.voice, signal: controller.signal, onEvent: emit, sessionCache })
        emit({ type: 'done', ...result })
      } catch (error) {
        // Only our transport's controlled messages are safe; arbitrary errors may contain secrets.
        emit({ type: 'error', message: qwenFailureMessage(error) })
      }
      res.end()
    } catch {
      if (!res.headersSent) reply(500, { message: '本机配置处理失败，请重试。' })
      else res.end()
    } finally { active = false }
  })
  server.on('close', () => sessionCache.clear())
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createQwenAudition()
  server.listen(8792, '127.0.0.1', () => console.log('Qwen 云端流式试听：http://127.0.0.1:8792/'))
  server.on('error', () => { console.error('试听页启动失败，请检查 8792 端口。'); process.exitCode = 1 })
}
