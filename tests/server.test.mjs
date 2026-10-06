import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createApp } from '../apps/cohost/server.mjs'

async function start(t, options = {}) {
  const server = createApp(options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}`
  return { get: path => fetch(url + path), post: (path, data, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) }) }
}

test('page and health work without a model key; model request fails explicitly', async t => {
  const app = await start(t, { apiKey: '', token: '' })
  assert.equal((await app.get('/')).status, 200)
  assert.equal((await app.get('/healthz')).status, 200)
  const status = await (await app.get('/api/status')).json()
  assert.equal(status.deepseekConfigured, false)
  assert.equal((await app.post('/api/reply', { source: 'host', text: '你好' })).status, 503)
  assert.equal((await app.post('/api/mute', { value: 'false' })).status, 400)
})

test('token protects control API and status does not expose credentials', async t => {
  const token = 'test-token-only-24-characters'
  const app = await start(t, { apiKey: 'private-provider-key', token })
  assert.equal((await app.get('/api/status')).status, 401)
  assert.equal((await app.post('/api/mute', { value: true })).status, 401)
  const response = await app.post('/api/mute', { value: true }, { Authorization: `Bearer ${token}` })
  assert.equal(response.status, 200)
  assert.equal((await response.text()).includes('private-provider-key'), false)
})

test('reply streams answer and reuses completed history', async t => {
  const seen = []
  async function* reply(options) { seen.push(options); yield '你好'; yield '，主播。' }
  const app = await start(t, { apiKey: 'test-only', token: '', reply })
  const first = await app.post('/api/reply', { source: 'host', text: '打个招呼' })
  const events = (await first.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.filter(x => x.type === 'delta').map(x => x.text).join(''), '你好，主播。')
  assert.equal(events.at(-1).type, 'done')
  await (await app.post('/api/reply', { source: 'host', text: '继续' })).text()
  assert.equal(seen[1].history.length, 2)
})

test('host speaking aborts an in-flight model call and partial history is discarded', async t => {
  let resolveStarted
  const started = new Promise(resolve => { resolveStarted = resolve })
  async function* reply({ signal }) {
    yield '未完成'
    resolveStarted()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    yield '不能播出'
  }
  const app = await start(t, { apiKey: 'test-only', token: '', reply })
  const responsePromise = app.post('/api/reply', { source: 'host', text: '聊聊' })
  await started
  await app.post('/api/host-speaking', { value: true })
  const events = await (await responsePromise).text()
  assert.ok(events.includes('cancelled'))
  assert.equal(events.includes('不能播出'), false)
  const status = await (await app.get('/api/status')).json()
  assert.equal(status.busy, false)
})

test('rejects invalid platform and cross-site control requests', async t => {
  const app = await start(t, { token: '' })
  assert.equal((await app.post('/api/danmaku', { platform: 'unknown' })).status, 400)
  assert.equal((await app.post('/api/mute', { value: true }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
})
