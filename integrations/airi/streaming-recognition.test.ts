import { describe, expect, it, vi } from 'vitest'

import { StreamingRecognition } from './streaming-recognition'

function relay() {
  let output: ReadableStreamDefaultController<Uint8Array>
  const requests: { path: string, body: Record<string, unknown> }[] = []
  const fetchImpl: typeof fetch = vi.fn(async (url, options) => {
    const path = String(url).split('/').at(-1)!
    requests.push({ path, body: JSON.parse(String(options?.body)) })
    if (path === 'open') {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller
        },
      }))
    }
    return Response.json({ accepted: true })
  })
  return { requests, fetchImpl, frame: (value: Record<string, unknown>) => output.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`)) }
}

describe('streaming microphone recognition', () => {
  it('uploads one 32 ms frame without waiting for a later frame or the end of speech', async () => {
    const server = relay()
    const segment = new StreamingRecognition('http://localhost', {}, 1, vi.fn(), vi.fn(), vi.fn(), server.fetchImpl)
    server.frame({ type: 'ready' })
    segment.push(new Float32Array(512).fill(0.5))
    await vi.waitFor(() => expect(server.requests.at(-1)?.path).toBe('chunk'))
    expect(atob(String(server.requests.at(-1)?.body.pcm))).toHaveLength(1024)
    expect(server.requests.some(item => item.path === 'finish')).toBe(false)
    segment.cancel()
  })

  it('uploads during speech, shows drafts, and delivers once after the local pause and cloud completion', async () => {
    const server = relay()
    const partial = vi.fn()
    const final = vi.fn()
    const error = vi.fn()
    const segment = new StreamingRecognition('http://localhost', {}, 1, partial, final, error, server.fetchImpl)
    segment.push(new Float32Array(3200).fill(0.5))
    expect(server.requests.map(item => item.path)).toEqual(['open'])
    server.frame({ type: 'ready' })
    await vi.waitFor(() => expect(server.requests.some(item => item.path === 'chunk')).toBe(true))
    server.frame({ type: 'partial', text: '小鲸鱼' })
    await vi.waitFor(() => expect(partial).toHaveBeenCalledWith('小鲸鱼'))
    expect(final).not.toHaveBeenCalled()
    expect(server.requests.some(item => item.path === 'finish')).toBe(false)
    segment.end()
    await vi.waitFor(() => expect(server.requests.at(-1)?.path).toBe('finish'))
    server.frame({ type: 'final', text: '小鲸鱼你好', asrMs: 123 })
    await vi.waitFor(() => expect(final).toHaveBeenCalledExactlyOnceWith('小鲸鱼你好'))
    expect(error).not.toHaveBeenCalled()
    const bytes = atob(String(server.requests.find(item => item.path === 'chunk')?.body.pcm))
    expect(bytes.length).toBe(6400)
  })

  it('discards late results after capture ends without changing playback', async () => {
    const server = relay()
    const final = vi.fn()
    const partial = vi.fn()
    const error = vi.fn()
    const segment = new StreamingRecognition('http://localhost', {}, 2, partial, final, error, server.fetchImpl)
    segment.cancel()
    server.frame({ type: 'final', text: '旧话', asrMs: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(final).not.toHaveBeenCalled()
    expect(partial).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('bounds queued audio and rejects premature completion', async () => {
    const server = relay()
    const error = vi.fn()
    const segment = new StreamingRecognition('http://localhost', {}, 3, vi.fn(), vi.fn(), error, server.fetchImpl)
    segment.push(new Float32Array(128001))
    expect(error).toHaveBeenCalledOnce()
    const other = relay()
    const final = vi.fn()
    const secondError = vi.fn()
    const premature = new StreamingRecognition('http://localhost', {}, 4, vi.fn(), final, secondError, other.fetchImpl)
    other.frame({ type: 'final', text: '尚在讲话', asrMs: 1 })
    await vi.waitFor(() => expect(secondError).toHaveBeenCalledOnce())
    expect(final).not.toHaveBeenCalled()
    premature.cancel()
  })
})
