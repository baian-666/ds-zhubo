import test from 'node:test'
import assert from 'node:assert/strict'
import { answerDeltas, streamReply } from '../apps/cohost/deepseek.mjs'

function body(text, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
    controller.close()
  } })
}

test('SSE survives split Chinese bytes and ignores reasoning and heartbeat', async () => {
  const stream = ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"不输出"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'
  assert.deepEqual(await Array.fromAsync(answerDeltas(body(stream))), ['你好'])
})

test('truncated stream fails rather than pretending response completed', async () => {
  await assert.rejects(() => Array.fromAsync(answerDeltas(body('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'))), /before completion/)
})

test('DeepSeek request uses server key, bounded output and disabled thinking', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url, ...options }
    return new Response(body('data: {"choices":[{"delta":{"content":"好呀"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
  }
  const chunks = await Array.fromAsync(streamReply({ apiKey: 'test-only', input: { source: 'host', text: '你好' }, signal: new AbortController().signal, fetchImpl }))
  const sent = JSON.parse(request.body)
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(request.headers.Authorization, 'Bearer test-only')
  assert.equal(sent.thinking.type, 'disabled')
  assert.equal(sent.stream, true)
  assert.equal(sent.max_tokens, 256)
  assert.equal(sent.messages.at(-1).role, 'user')
  assert.deepEqual(chunks, ['好呀'])
})

test('HTTP errors do not return potentially sensitive provider body', async () => {
  await assert.rejects(() => Array.fromAsync(streamReply({ apiKey: 'test-only', input: {}, signal: new AbortController().signal, fetchImpl: async () => new Response('secret body', { status: 401 }) })), /^Error: DeepSeek HTTP 401$/)
})
