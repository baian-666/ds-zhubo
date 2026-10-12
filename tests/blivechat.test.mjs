import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { BlivechatRelay, localRelayUrl, normalizeBlivechat } from '../apps/cohost/blivechat.mjs'
import { createApp } from '../apps/cohost/server.mjs'

const dm = (id = 'msg', patch = {}) => {
  const d = [
    '',
    Math.floor(Date.now() / 1000),
    '猫咪观众',
    0,
    '跑步机被猫咪占领了',
    0,
    0,
    1,
    0,
    1,
    0,
    id,
    '',
    0,
    [],
    [],
    'viewer-id',
    '',
    0,
  ]
  Object.assign(d, patch)
  return { cmd: 2, data: d }
}
const wait = async (f) => {
  for (let i = 0; i < 100; i++) {
    if (f()) return
    await delay(5)
  }
  assert.fail('timed out')
}
function fixture(options = {}) {
  const sockets = [],
    messages = []
  class Socket extends EventTarget {
    constructor(url) {
      super()
      this.url = url
      this.sent = []
      sockets.push(this)
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(data) {
      this.sent.push(JSON.parse(data))
      if (this.sent.at(-1).cmd === 1) queueMicrotask(() => this.emit({ cmd: 0 }))
    }
    emit(message) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
    }
    close() {
      this.closed = true
      this.dispatchEvent(new Event('close'))
    }
  }
  const client = new BlivechatRelay({
    config: { url: 'ws://127.0.0.1:12451/api/chat', code: 'fixture-private-code' },
    WebSocketImpl: Socket,
    retryMs: 5,
    onMessage: (m) => {
      messages.push(m)
      return true
    },
    ...options,
  })
  return { client, sockets, messages, Socket }
}
test('relay URL permits only explicit loopback endpoints and never sends credentials elsewhere', () => {
  assert.equal(localRelayUrl('ws://localhost:12451/api/chat'), 'ws://127.0.0.1:12451/api/chat')
  for (const url of [
    'ws://evil.invalid/api/chat',
    'ws://127.0.0.1.evil.invalid/api/chat',
    'wss://127.0.0.1/api/chat',
    'ws://secret@127.0.0.1/api/chat',
    'ws://127.0.0.1/api/chat?code=secret',
    'ws://127.0.0.1/other',
  ])
    assert.throws(() => localRelayUrl(url))
  const f = fixture({ config: { url: 'ws://evil.invalid/api/chat', code: 'fixture-private-code' } })
  assert.equal(f.client.start().configured, false)
  assert.equal(f.sockets.length, 0)
  assert.ok(!JSON.stringify(f.client.status()).includes('fixture-private-code'))
})
test('blivechat protocol filters historical, mirror, gift, emoticon and malformed messages', () => {
  assert.equal(normalizeBlivechat(dm(), 'room').text, '跑步机被猫咪占领了')
  for (const patch of [
    { 1: Math.floor(Date.now() / 1000) - 21 },
    { 1: Infinity },
    { 4: '' },
    { 4: 'a'.repeat(501) },
    { 6: 1 },
    { 13: 1 },
    { 18: 1 },
    { 16: '' },
    { 11: '' },
    { 3: 8 },
  ])
    assert.equal(normalizeBlivechat(dm('x', patch), 'room'), null)
  assert.equal(normalizeBlivechat({ cmd: 3, data: dm().data }, 'room'), null)
  assert.notEqual(normalizeBlivechat(dm(), 'room-a').id, normalizeBlivechat(dm(), 'room-b').id)
})
test('subscribes once without translation, echoes heartbeat and ignores unknown commands', async (t) => {
  const f = fixture()
  t.after(() => f.client.stop())
  f.client.start()
  await wait(() => f.client.state === 'connected')
  assert.deepEqual(f.sockets[0].sent, [
    {
      cmd: 1,
      data: { roomKey: { type: 2, value: 'fixture-private-code' }, config: { autoTranslate: false } },
    },
    { cmd: 0 },
  ])
  f.sockets[0].emit({ cmd: 7, data: ['translation', 'ignored'] })
  f.sockets[0].emit(dm())
  assert.equal(f.messages.length, 1)
  assert.equal(f.client.status().source, 'blivechat')
  assert.ok(!JSON.stringify(f.client.status()).includes('fixture-private-code'))
})
test('reconnects boundedly and discards stale socket and stop-delayed messages', async (t) => {
  const f = fixture()
  t.after(() => f.client.stop())
  f.client.start()
  await wait(() => f.client.state === 'connected')
  const old = f.sockets[0]
  old.close()
  await wait(() => f.sockets.length === 2 && f.client.state === 'connected')
  old.emit(dm('old'))
  f.sockets[1].emit(dm('new'))
  assert.equal(f.messages.length, 1)
  await f.client.stop()
  f.sockets[1].emit(dm('late'))
  assert.equal(f.messages.length, 1)
  f.client.start()
  await wait(() => f.sockets.length === 3 && f.client.state === 'connected')
  for (let i = 2; i < 8; i++) {
    f.sockets[i].close()
    if (i < 7) await wait(() => f.sockets.length === i + 2 && f.client.state === 'connected')
  }
  await wait(() => f.client.state === 'error')
  assert.equal(f.client.retries, 6)
})
test('fatal authentication and oversized messages stop without retaining relay error text', async (t) => {
  for (const message of [
    { cmd: 8, data: { type: 1, msg: 'fixture-private-code' } },
    { cmd: 2, data: 'x'.repeat(70_000) },
  ]) {
    const f = fixture()
    t.after(() => f.client.stop())
    f.client.start()
    await wait(() => f.client.state === 'connected')
    f.sockets[0].emit(message)
    await wait(() => f.client.state === 'error')
    assert.equal(f.sockets.length, 1)
    assert.ok(!JSON.stringify(f.client.status()).includes('fixture-private-code'))
  }
})
test('silent relay times out and the intake budget bounds scene work', async (t) => {
  let now = 1000
  const f = fixture({ now: () => now, timeoutMs: 5 })
  t.after(() => f.client.stop())
  f.client.start()
  await wait(() => f.client.state === 'connected')
  now += 100
  await wait(() => f.client.retries > 0)
  await f.client.stop()
  for (let i = 0; i < 80; i++) f.client.receive(dm(String(i), { 1: now / 1000 }))
  assert.equal(f.messages.length, 30)
  assert.equal(f.client.dropped, 50)
})
test('local relay reaches shared viewer pipeline once while simulated inputs cannot impersonate it', async (t) => {
  const f = fixture(),
    app = createApp({
      apiKey: '',
      bilibiliOptions: { source: 'blivechat', config: f.client.config, WebSocketImpl: f.Socket },
    })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(
    () =>
      new Promise((r) => {
        app.closeAllConnections()
        app.close(r)
      }),
  )
  const base = `http://127.0.0.1:${app.address().port}`,
    post = (path, body = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
  await post('/api/bilibili/start')
  await wait(() => f.sockets[0]?.sent.length === 2)
  f.sockets[0].emit(dm())
  f.sockets[0].emit(dm())
  await post('/api/danmaku', { id: 'fake', platform: 'bilibili', userId: 'fake', text: '模拟', real: true })
  const state = await fetch(base + '/api/status').then((r) => r.json())
  assert.equal(state.bilibili.source, 'blivechat')
  assert.equal(state.bilibili.accepted, 1)
  assert.equal(state.room.entries.filter((e) => e.role === 'viewer' && e.real).length, 1)
  assert.equal(state.room.entries.find((e) => e.text === '模拟').real, false)
  await post('/api/bilibili/stop')
})
