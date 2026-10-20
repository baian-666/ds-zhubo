import test from 'node:test'
import assert from 'node:assert/strict'
import { recognizeCloud } from '../apps/cohost/recognition-request.mjs'
const base = { key: 'fixture-key', body: new FormData(), hedgeMs: 5, timeoutMs: 100 }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

test('fast ASR uses one request, including a valid empty transcript', async () => {
  let calls = 0
  const result = await recognizeCloud({ ...base, fetchImpl: async () => { calls++; return Response.json({ text: '' }) } })
  assert.equal(result.text, ''); await pause(10); assert.equal(calls, 1)
})

test('slow ASR body is hedged once; winner cancels old transport and ignores late text', async () => {
  let release, calls = 0; const signals = []
  const result = await recognizeCloud({ ...base, fetchImpl: async (_url, { signal }) => {
    signals.push(signal); calls++
    if (calls === 1) return { ok: true, json: () => new Promise(resolve => { release = resolve }) }
    return Response.json({ text: '正确的句子' })
  } })
  assert.equal(result.text, '正确的句子'); assert.equal(calls, 2); assert.ok(signals[0].aborted)
  release({ text: '迟到的旧结果' }); await pause(10); assert.equal(calls, 2)
})

test('original ASR can still win after duplicate fails', async () => {
  let calls = 0
  const result = await recognizeCloud({ ...base, fetchImpl: async () => {
    calls++; if (calls === 2) throw Error('private provider error')
    await pause(20); return Response.json({ text: '第一份有效结果' })
  } })
  assert.equal(result.text, '第一份有效结果'); assert.equal(calls, 2)
})

test('cancel and deadline release both ASR requests even when transport ignores cancellation', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(), signals = []
    const request = recognizeCloud({ ...base, timeoutMs: 30, signal: controller.signal,
      fetchImpl: async (_url, { signal }) => { signals.push(signal); return new Promise(() => {}) } })
    const rejected = assert.rejects(request, e => e.status === (cancel ? 409 : 504))
    if (cancel) { await pause(15); controller.abort() }
    await rejected; assert.equal(signals.length, 2); assert.ok(signals.every(s => s.aborted))
  }
})

test('ASR does not retry quota or authentication errors, and retries network failure at most once', async () => {
  for (const status of [401, 402, 429, 500, 'network']) {
    let calls = 0
    await assert.rejects(recognizeCloud({ ...base, fetchImpl: async () => {
      calls++; if (status === 'network') throw Error('fixture-key private failure')
      return new Response('private error', { status })
    } }), e => e.status === 502 && !e.message.includes('fixture-key'))
    await pause(10); assert.equal(calls, [401, 402, 429].includes(status) ? 1 : 2)
  }
})
