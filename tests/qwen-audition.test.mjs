import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { streamQwen, createQwenSessionCache } from '../scripts/qwen-realtime-client.mjs'
import { createQwenAudition } from '../scripts/qwen-audition.mjs'
import { saveVoiceKey } from '../scripts/configure-voice.mjs'
import { normalizeQwenKey, qwenKeyIssue } from '../scripts/qwen-credential.mjs'

const fakeKey = 'sk-qwen-test-not-a-real-credential'
class FakeSocket extends EventTarget {
  static last
  constructor(url, options) {
    super(); this.url = url; this.options = options; this.sent = []; this.closed = false
    FakeSocket.last = this; this.readyState = 0
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
  }
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')) }
  emit(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('Qwen credentials accept bearer-token symbols and pasted wrappers without changing the token', () => {
  const credential = 'sk-fake.test~with+symbols/path=='
  assert.equal(qwenKeyIssue(credential), null)
  for (const input of ['\u200B ' + credential + '\r\n', 'Bearer ' + credential, '"' + credential + '"', 'DASHSCOPE_API_KEY="' + credential + '"'])
    assert.equal(normalizeQwenKey(input), credential)
  assert.match(qwenKeyIssue('sk-****masked-hidden'), /隐藏符号/)
  assert.match(qwenKeyIssue('sk-fake\nnot-a-real-key'), /空格或换行/)
  assert.ok(qwenKeyIssue('sk-test#not-a-real-key'))
})

test('Qwen setup normalizes a wrapped key before validation and persists its exact token', async t => {
  const credential = 'sk-fake.test~with+symbols/path=='
  let calls = 0
  const app = await setup(t, async options => { calls++; assert.equal(options.key, credential); return {} })
  const response = await app.post('/save', { key: '  DASHSCOPE_API_KEY="' + credential + '"\r\n' })
  assert.equal(response.status, 200)
  assert.ok(!(await response.text()).includes(credential))
  assert.equal(readFileSync(app.envPath, 'utf8').trim(), 'DASHSCOPE_API_KEY=' + credential)
  const invalid = await app.post('/save', { key: 'sk-****masked-hidden' })
  assert.equal(invalid.status, 400)
  assert.match((await invalid.json()).message, /隐藏符号/)
  assert.equal(calls, 1)
})

test('Qwen sends PCM before completion and records connection separately from synthesis', async () => {
  const events = []
  const result = streamQwen({ key: fakeKey, text: '你好呀。', onEvent: event => events.push(event), WebSocketImpl: FakeSocket })
  await tick()
  const ws = FakeSocket.last
  assert.equal(ws.options.headers.Authorization, 'Bearer ' + fakeKey)
  assert.ok(!ws.url.includes(fakeKey))
  assert.equal(ws.sent[0].type, 'session.update')
  assert.equal(ws.sent[0].session.mode, 'commit')
  ws.emit({ type: 'session.updated' })
  assert.deepEqual(ws.sent.slice(1).map(x => x.type), ['input_text_buffer.append', 'input_text_buffer.commit'])
  ws.emit({ type: 'response.audio.delta', delta: Buffer.alloc(4800, 2).toString('base64') })
  assert.equal(events.at(-1).type, 'audio')
  assert.equal(ws.closed, false)
  ws.emit({ type: 'response.done', response: { status: 'completed' } })
  const done = await result
  assert.equal(done.chunks, 1); assert.equal(done.audioSeconds, 0.1)
  assert.ok(done.firstPcmMs >= done.synthesisFirstPcmMs)
  assert.equal(ws.closed, true)
})

test('Qwen reuses a prepared session for repeated same-voice replies without updating a started session', async t => {
  const sessionCache = createQwenSessionCache(); t.after(() => sessionCache.clear())
  const options = { key: fakeKey, voice: 'Vivian', sessionCache, WebSocketImpl: FakeSocket }
  const prepared = streamQwen({ ...options, validateOnly: true })
  await tick(); const socket = FakeSocket.last
  socket.emit({ type: 'session.updated' }); await prepared
  assert.equal(socket.closed, false)
  for (const text of ['第一句', '第二句']) {
    const events = []
    const request = streamQwen({ ...options, text, onEvent: e => events.push(e) })
    assert.equal(FakeSocket.last, socket)
    assert.equal(events[0].reusedConnection, true)
    socket.emit({ type: 'response.audio.delta', delta: Buffer.alloc(4800).toString('base64') })
    socket.emit({ type: 'response.done' })
    const done = await request
    assert.equal(done.chunks, 1); assert.equal(done.reusedConnection, true)
    assert.equal(socket.closed, false)
  }
  assert.equal(socket.sent.filter(e => e.type === 'session.update').length, 1)
  assert.deepEqual(socket.sent.filter(e => e.type === 'input_text_buffer.append').map(e => e.text), ['第一句', '第二句'])
})

test('Qwen cached sessions separate changed voices and credentials, and expire when idle', async t => {
  const sessionCache = createQwenSessionCache({ idleMs: 15 }); t.after(() => sessionCache.clear())
  let previous
  for (const [key, voice] of [[fakeKey, 'Cherry'], [fakeKey, 'Vivian'], ['sk-other-fixture-not-a-real-key', 'Vivian']]) {
    const request = streamQwen({ key, voice, validateOnly: true, sessionCache, WebSocketImpl: FakeSocket })
    await tick(); const socket = FakeSocket.last
    if (previous) { assert.notEqual(socket, previous); assert.equal(previous.closed, true) }
    socket.emit({ type: 'session.updated' }); await request; previous = socket
  }
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(previous.closed, true)
})

test('cancelling a reused Qwen session closes it, drops late audio and reconnects cleanly', async t => {
  const sessionCache = createQwenSessionCache(); t.after(() => sessionCache.clear())
  const options = { key: fakeKey, sessionCache, WebSocketImpl: FakeSocket }
  const prepared = streamQwen({ ...options, validateOnly: true })
  await tick(); const old = FakeSocket.last; old.emit({ type: 'session.updated' }); await prepared
  const controller = new AbortController(), events = []
  const request = streamQwen({ ...options, text: '要停止的话', signal: controller.signal, onEvent: e => events.push(e) })
  const rejected = assert.rejects(request, /已停止/)
  controller.abort(); old.emit({ type: 'response.audio.delta', delta: Buffer.alloc(4800).toString('base64') })
  await rejected; assert.equal(old.closed, true); assert.equal(events.filter(e => e.type === 'audio').length, 0)
  const next = streamQwen({ ...options, validateOnly: true })
  await tick(); assert.notEqual(FakeSocket.last, old)
  FakeSocket.last.emit({ type: 'session.updated' }); await next
})

test('validation submits no text; cancellation drops late audio; errors hide provider details', async () => {
  const validation = streamQwen({ key: fakeKey, validateOnly: true, WebSocketImpl: FakeSocket })
  await tick(); FakeSocket.last.emit({ type: 'session.updated' }); await validation
  assert.deepEqual(FakeSocket.last.sent.map(x => x.type), ['session.update'])
  const controller = new AbortController(), events = []
  const request = streamQwen({ key: fakeKey, text: '测试', signal: controller.signal, onEvent: e => events.push(e), WebSocketImpl: FakeSocket })
  const rejection = assert.rejects(request, /已停止/)
  await tick(); const old = FakeSocket.last; controller.abort()
  old.emit({ type: 'response.audio.delta', delta: Buffer.alloc(100).toString('base64') })
  await rejection; assert.equal(events.length, 0); assert.ok(old.closed)
  const failure = streamQwen({ key: fakeKey, text: '测试', WebSocketImpl: FakeSocket })
  const hidden = assert.rejects(failure, error => !error.message.includes(fakeKey) && /百炼/.test(error.message))
  await tick(); FakeSocket.last.emit({ type: 'error', error: { message: fakeKey } }); await hidden
})

test('malformed audio and premature disconnect never report successful completion', async () => {
  const pending = streamQwen({ key: fakeKey, text: '测试', WebSocketImpl: FakeSocket })
  const rejected = assert.rejects(pending, /格式异常/)
  await tick(); FakeSocket.last.emit({ type: 'session.updated' })
  FakeSocket.last.emit({ type: 'response.audio.delta', delta: 'AA==' })
  await rejected
  const next = streamQwen({ key: fakeKey, text: '测试', WebSocketImpl: FakeSocket })
  const closed = assert.rejects(next, /提前结束/)
  await tick(); FakeSocket.last.close(); await closed
})

test('Node native WebSocket sends its custom Authorization header', async t => {
  const server = createServer()
  let connection
  t.after(() => { connection?.destroy(); server.close() })
  const captured = new Promise(resolve => server.on('upgrade', (req, socket) => {
    connection = socket
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    resolve(req.headers.authorization)
  }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const ws = new WebSocket('ws://127.0.0.1:' + server.address().port, { headers: { Authorization: 'Bearer ' + fakeKey } })
  t.after(() => { try { ws.close() } catch {} })
  const opened = new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  assert.equal(await captured, 'Bearer ' + fakeKey); await opened
})

async function setup(t, stream) {
  const folder = mkdtempSync(join(tmpdir(), 'cohost-qwen-test-')), envPath = join(folder, '.env')
  const server = createQwenAudition({ envPath, stream })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    const target = resolve(folder), base = resolve(tmpdir()) + sep
    assert.ok(target.startsWith(base)); rmSync(target, { recursive: true, force: true })
  })
  const base = 'http://127.0.0.1:' + server.address().port
  const html = await (await fetch(base)).text(), token = html.match(/name="csrf" content="([^"]+)"/)[1]
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Setup-Token': token, ...headers }, body: JSON.stringify(body) })
  return { envPath, base, post, html }
}

test('local Qwen setup preserves existing settings, rejects cross-origin and hides credentials', async t => {
  let calls = 0
  const app = await setup(t, async options => { calls++; assert.ok(options.validateOnly); return {} })
  writeFileSync(app.envPath, 'DEEPSEEK_API_KEY=keep-test\r\nSILICONFLOW_API_KEY=keep-voice-test\r\n')
  assert.equal((await app.post('/save', { key: fakeKey }, { Origin: 'https://other.example' })).status, 403)
  assert.equal(calls, 0)
  const response = await app.post('/save', { key: fakeKey })
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(fakeKey))
  const text = readFileSync(app.envPath, 'utf8')
  assert.ok(text.includes('DEEPSEEK_API_KEY=keep-test\r\nSILICONFLOW_API_KEY=keep-voice-test\r\n'))
  assert.ok(text.includes('DASHSCOPE_API_KEY=' + fakeKey))
  assert.deepEqual(await (await fetch(app.base + '/status')).json(), { configured: true })
  assert.ok(!(await (await fetch(app.base)).text()).includes(fakeKey))
  assert.throws(() => saveVoiceKey(app.envPath, fakeKey, 'OTHER_NAME'))
})

test('local Qwen preconnection validates the selected voice without submitting synthesis text', async t => {
  const app = await setup(t, async options => {
    assert.ok(options.validateOnly); assert.equal(options.voice, 'Vivian'); assert.equal(options.text, undefined)
    assert.ok(options.sessionCache); return {}
  })
  writeFileSync(app.envPath, 'DASHSCOPE_API_KEY=' + fakeKey)
  const response = await app.post('/prepare', { voice: 'Vivian' })
  assert.equal(response.status, 200); assert.match((await response.json()).message, /就绪/)
  assert.equal((await app.post('/prepare', { voice: 'Vivian' }, { Origin: 'https://other.example' })).status, 403)
})

test('HTTP relays incremental audio and aborts upstream when the consumer disconnects', async t => {
  let cancel
  const cancelled = new Promise(resolve => { cancel = resolve })
  const app = await setup(t, async ({ onEvent, signal }) => {
    onEvent({ type: 'audio', pcm: Buffer.alloc(4800).toString('base64'), sampleRate: 24000 })
    await new Promise(resolve => signal.addEventListener('abort', () => { cancel(); resolve() }, { once: true }))
    return {}
  })
  writeFileSync(app.envPath, 'DASHSCOPE_API_KEY=' + fakeKey)
  const response = await app.post('/trial', { text: '你好', voice: 'Cherry' })
  const reader = response.body.getReader(), first = await reader.read()
  assert.ok(new TextDecoder().decode(first.value).includes('"type":"audio"'))
  await reader.cancel(); await cancelled
})

test('unexpected server errors never echo secret details', async t => {
  const app = await setup(t, async () => { throw new Error(fakeKey) })
  writeFileSync(app.envPath, 'DASHSCOPE_API_KEY=' + fakeKey)
  const result = await app.post('/trial', { text: '测试', voice: 'Cherry' })
  const text = await result.text()
  assert.ok(text.includes('"type":"error"')); assert.ok(!text.includes(fakeKey))
  const saved = await app.post('/save', { key: fakeKey })
  assert.equal(saved.status, 502)
  const message = (await saved.json()).message
  assert.match(message, /连接失败/); assert.match(message, /未保存/); assert.ok(!message.includes(fakeKey))
})

test('Qwen setup distinguishes safe connection errors from local credential write errors', async t => {
  const failed = await setup(t, async () => { throw new Error('语音请求超时，请稍后重试。') })
  const timeout = await failed.post('/save', { key: fakeKey })
  assert.equal(timeout.status, 502)
  assert.match((await timeout.json()).message, /请求超时.*未保存/)
  const conflict = await setup(t, async () => ({}))
  // Test the atomic staging failure while leaving a previous credential intact.
  writeFileSync(join(dirname(conflict.envPath), 'data'), 'occupied')
  writeFileSync(conflict.envPath, 'DEEPSEEK_API_KEY=preserved-fixture\n')
  const failure = await conflict.post('/save', { key: fakeKey })
  assert.equal(failure.status, 500)
  const result = await failure.json()
  assert.match(result.message, /连接成功.*写入失败/)
  assert.ok(!result.message.includes(fakeKey))
  assert.equal(readFileSync(conflict.envPath, 'utf8'), 'DEEPSEEK_API_KEY=preserved-fixture\n')
})
