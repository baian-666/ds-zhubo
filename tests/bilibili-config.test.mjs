import test from 'node:test'
import { request } from 'node:http'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { saveBilibiliConfig, createBilibiliSetup } from '../scripts/configure-bilibili.mjs'
import { createApp } from '../apps/cohost/server.mjs'
function temp(t) {
  const root = resolve('data')
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'bili-test-'))
  t.after(() => {
    assert.ok(realpathSync(dir).startsWith(root + sep))
    rmSync(dir, { recursive: true, force: true })
  })
  return join(dir, '.env')
}
test('local save preserves unrelated credentials and atomically replaces only relay fields', (t) => {
  const path = temp(t)
  writeFileSync(
    path,
    'DEEPSEEK_API_KEY=fixture-secret\r\nCOHOST_ACCESS_TOKEN=fixture-token\r\nBILIBILI_SOURCE=official\r\nBILIBILI_ANCHOR_CODE=old\r\n',
  )
  saveBilibiliConfig(path, { kind: 'code', value: 'fixture-identity#literal' })
  const env = parseEnv(readFileSync(path, 'utf8'))
  assert.equal(env.DEEPSEEK_API_KEY, 'fixture-secret')
  assert.equal(env.COHOST_ACCESS_TOKEN, 'fixture-token')
  assert.equal(env.BILIBILI_ANCHOR_CODE, 'fixture-identity#literal')
  assert.equal(env.BILIBILI_SOURCE, 'blivechat')
  const before = readFileSync(path, 'utf8')
  for (const value of ['bad\ncode', 'bad"code'])
    assert.throws(() => saveBilibiliConfig(path, { kind: 'code', value }))
  assert.equal(readFileSync(path, 'utf8'), before)
  saveBilibiliConfig(path, { kind: 'room', value: '123' })
  assert.equal(parseEnv(readFileSync(path, 'utf8')).BILIBILI_ANCHOR_CODE, '')
})
test('setup requires local host, same origin and page nonce and never returns stored values', async (t) => {
  const path = temp(t)
  writeFileSync(path, 'COHOST_ACCESS_TOKEN=fixture-token\n')
  let calls = 0
  const server = createBilibiliSetup({
    envPath: path,
    fetchImpl: async (url, opts) => {
      calls++
      assert.equal(url, 'http://127.0.0.1:8787/api/bilibili/reload')
      assert.equal(opts.headers.Authorization, 'Bearer fixture-token')
      assert.equal(opts.body, '{}')
      return Response.json({ ok: true })
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
  )
  const base = `http://127.0.0.1:${server.address().port}`,
    html = await fetch(base).then((r) => r.text()),
    nonce = html.match(/script nonce="([^"]+)"/)[1]
  const post = (headers) =>
    fetch(base + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Setup-Token': nonce, ...headers },
      body: JSON.stringify({ kind: 'code', value: 'fixture-private-identity' }),
    })
  assert.equal((await post({ 'X-Setup-Token': 'bad' })).status, 403)
  assert.equal((await post({ Origin: 'https://evil.invalid' })).status, 403)
  const wrongHost = await new Promise((resolve) => {
    const q = request(base, { headers: { Host: 'evil.invalid' } }, (r) => {
      r.resume()
      resolve(r.statusCode)
    })
    q.end()
  })
  assert.equal(wrongHost, 403)
  const saved = await post({})
  assert.equal(saved.status, 200)
  assert.ok(!(await saved.text()).includes('fixture-private-identity'))
  assert.equal(calls, 1)
  assert.ok(!(await fetch(base).then((r) => r.text())).includes('fixture-private-identity'))
})
test('reload only changes chat source and rejects invalid configuration without disrupting room', async (t) => {
  const path = temp(t)
  saveBilibiliConfig(path, { kind: 'room', value: '123' })
  const app = createApp({ apiKey: '', token: 'fixture-token', bilibiliEnvPath: path })
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
    headers = { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-token' },
    post = (route, h = headers) =>
      fetch(base + route, {
        method: 'POST',
        headers: h,
        body: route.endsWith('danmaku')
          ? JSON.stringify({ platform: 'manual', id: 'keep', userId: 'keep', text: '保留原聊天' })
          : '{}',
      })
  await post('/api/danmaku')
  assert.equal((await post('/api/bilibili/reload', { 'Content-Type': 'application/json' })).status, 401)
  assert.equal((await post('/api/bilibili/reload')).status, 200)
  writeFileSync(
    path,
    'BILIBILI_SOURCE=blivechat\nBILIBILI_RELAY_URL=ws://evil.invalid/api/chat\nBILIBILI_ANCHOR_CODE=private\n',
  )
  assert.equal((await post('/api/bilibili/reload')).status, 400)
  const state = await fetch(base + '/api/status', { headers }).then((r) => r.json())
  assert.equal(state.bilibili.source, 'blivechat')
  assert.equal(state.bilibili.roomId, '123')
  assert.equal(state.bilibili.state, 'disconnected')
  assert.equal(state.airi.active, false)
  assert.ok(state.room.entries.some((e) => e.text === '保留原聊天'))
})
