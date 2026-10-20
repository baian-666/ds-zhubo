import type { Status, StatusFrame } from './cohost-status-contract'

import { afterEach, expect, it, vi } from 'vitest'

import { StatusConnection } from './cohost-status-connection'
import { statusEvent } from './cohost-status-contract'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
})
function snapshot(epoch: string): StatusFrame {
  return { kind: 'snapshot', epoch, revision: 0, status: {
    live: false,
    deepseekConfigured: true,
    busy: false,
    muted: false,
    hostSpeaking: false,
    bilibili: { source: '', configured: false, state: 'idle', error: null, roomId: null, received: 0, accepted: 0, dropped: 0 },
    configuration: { model: 'fixture', persona: '小鲸鱼', cardId: '', cardFingerprint: '', profileStage: '', profileRevision: '', recognition: '', speech: '', voice: '', speechBackend: 'index' },
    room: { session: epoch, version: 0, entries: [] },
    performance: null,
    airi: { active: false, capture: false, captureReady: false, ready: false, configured: false, stages: [] },
  } }
}
function response(frames: StatusFrame[]) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const bytes = new TextEncoder().encode(`${frames.map(body => JSON.stringify({ ...statusEvent, body })).join('\n')}\n`)
    // Exercise UTF-8 and JSON across arbitrary transport chunk boundaries.
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
  } }))
}

it('reconnects on a missing revision and replaces state from the new snapshot', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response([snapshot('first'), { kind: 'patch', epoch: 'first', base: 1, revision: 2, changes: { muted: true } }]))
    .mockResolvedValueOnce(response([snapshot('second')]))
  vi.stubGlobal('fetch', fetcher)
  const received: Status[] = []
  const connection = new StatusConnection(() => 'local-token', value => received.push(value), () => {}, () => {})
  cleanups.push(() => connection.stop())
  connection.start()
  await expect.poll(() => received.at(-1)?.room.session, { timeout: 3000 }).toBe('second')
  expect(received.map(state => state.configuration.persona)).toEqual(['小鲸鱼', '小鲸鱼'])
  expect(received.some(state => state.muted)).toBe(false)
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer local-token' })
})

it('waits for a changed credential after 401 and aborts on disposal', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(response([snapshot('authorized')]))
  vi.stubGlobal('fetch', fetcher)
  const unauthorized = vi.fn()
  const connected = vi.fn()
  let token = 'wrong'
  const connection = new StatusConnection(() => token, () => {}, connected, unauthorized)
  cleanups.push(() => connection.stop())
  connection.start()
  await expect.poll(() => unauthorized.mock.calls.length).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 600))
  expect(fetcher).toHaveBeenCalledTimes(1)
  token = 'correct'
  connection.start()
  await expect.poll(() => connected.mock.lastCall?.[0]).toBe(true)
  expect(fetcher.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer correct' })
  connection.stop()
  expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true)
  expect(connected.mock.lastCall).toEqual([false])
})
