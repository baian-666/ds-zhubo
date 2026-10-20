import type { PlaybackItem } from './types'

import { describe, expect, it, vi } from 'vitest'

import { createSpeechPipeline } from './speech-pipeline'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function playbackBoundary(autoEnd = true) {
  const items: PlaybackItem<string>[] = []
  const ends: Array<(event: { item: PlaybackItem<string>, endedAt: number }) => void> = []
  const rejects: Array<(event: { item: PlaybackItem<string>, reason: string }) => void> = []
  return {
    items,
    finish(item: PlaybackItem<string>) { ends.forEach(listener => listener({ item, endedAt: Date.now() })) },
    reject(item: PlaybackItem<string>) { rejects.forEach(listener => listener({ item, reason: 'device unavailable' })) },
    playback: {
      schedule(item: PlaybackItem<string>) {
        items.push(item)
        if (autoEnd)
          queueMicrotask(() => ends.forEach(listener => listener({ item, endedAt: Date.now() })))
      },
      stopAll: vi.fn(),
      stopByIntent: vi.fn(),
      stopByOwner: vi.fn(),
      onStart: vi.fn(),
      onInterrupt: vi.fn(),
      onReject(listener: (event: { item: PlaybackItem<string>, reason: string }) => void) { rejects.push(listener) },
      onEnd(listener: (event: { item: PlaybackItem<string>, endedAt: number }) => void) { ends.push(listener) },
    },
  }
}

describe('streamed speech playback', () => {
  it.each(['finish', 'reject'] as const)('waits for actual playback and handles %s without false delivery', async (outcome) => {
    const boundary = playbackBoundary(false)
    const pipeline = createSpeechPipeline<string>({
      tts: vi.fn(async () => null),
      async* ttsStream() { yield 'only' },
      playback: boundary.playback,
    })
    const delivered = vi.fn()
    const ended = vi.fn()
    pipeline.on('onSentencePlaybackEnd', delivered)
    pipeline.on('onTurnEnd', ended)
    const intent = pipeline.openIntent({ turnId: 'playback-gate' })
    intent.writeLiteral('必须播完。')
    intent.end()
    await vi.waitFor(() => expect(boundary.items).toHaveLength(1))
    expect(delivered).not.toHaveBeenCalled()
    boundary[outcome](boundary.items[0])
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce())
    expect(delivered).toHaveBeenCalledTimes(outcome === 'finish' ? 1 : 0)
  })

  it.each(['empty', 'failed'] as const)('does not acknowledge a %s synthesis stream', async (outcome) => {
    const boundary = playbackBoundary()
    const pipeline = createSpeechPipeline<string>({
      tts: vi.fn(async () => null),
      async* ttsStream() {
        if (outcome === 'failed') {
          yield 'incomplete'
          throw new Error('provider disconnected')
        }
      },
      playback: boundary.playback,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    const delivered = vi.fn()
    const ended = vi.fn()
    pipeline.on('onSentencePlaybackEnd', delivered)
    pipeline.on('onTurnEnd', ended)
    const intent = pipeline.openIntent({ turnId: 'failed-generation' })
    intent.writeLiteral('不能记为已说。')
    intent.end()
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce())
    expect(delivered).not.toHaveBeenCalled()
  })
  it('starts the first chunk without waiting for a second chunk or stream completion', async () => {
    const boundary = playbackBoundary()
    const rest = gate()
    const pipeline = createSpeechPipeline<string>({
      tts: vi.fn(async () => null),
      async* ttsStream() {
        yield 'first'
        await rest.promise
        yield 'last'
      },
      playback: boundary.playback,
    })
    const intent = pipeline.openIntent({ turnId: 'no-lookahead' })
    intent.writeLiteral('现在开始说。')
    intent.end()
    try {
      await vi.waitFor(() => expect(boundary.items.map(item => item.audio)).toEqual(['first']))
    }
    finally {
      rest.release()
    }
  })
  it('prepares the next sentence early but plays it after every chunk of the first sentence', async () => {
    const boundary = playbackBoundary()
    const last = gate()
    const started: string[] = []
    const pipeline = createSpeechPipeline<string>({
      tts: vi.fn(async () => null),
      async* ttsStream(request) {
        started.push(request.text)
        if (request.sequence === 0) {
          yield 'first-start'
          yield 'first-held'
          await last.promise
          yield 'first-end'
        }
        else {
          yield 'second-complete'
        }
      },
      playback: boundary.playback,
    })
    const ended = vi.fn()
    pipeline.on('onTurnEnd', ended)
    const intent = pipeline.openIntent({ turnId: 'prefetch' })
    intent.writeLiteral('第一句。第二句。')
    intent.end()
    await vi.waitFor(() => expect(started).toEqual(['第一句。', '第二句。']))
    expect(boundary.items.map(item => item.audio)).toEqual(['first-start', 'first-held'])
    last.release()
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce())
    expect(boundary.items.map(item => item.audio)).toEqual(['first-start', 'first-held', 'first-end', 'second-complete'])
  })

  it('keeps a prepared short utterance intact across punctuation and streams its original text', async () => {
    const boundary = playbackBoundary()
    const tts = vi.fn(async () => 'prepared-audio')
    const pipeline = createSpeechPipeline<string>({ tts, playback: boundary.playback })
    const intent = pipeline.openIntent({ turnId: 'prepared', wholeUtterance: true })
    intent.writeLiteral('猫老板，巡视呢。真威风！')
    intent.end()
    await vi.waitFor(() => expect(boundary.items).toHaveLength(1))
    expect(tts).toHaveBeenCalledOnce()
    expect(boundary.items[0].text).toBe('猫老板，巡视呢。真威风！')
  })
  it('waits for synthesis completion before acknowledging audio that already played', async () => {
    const boundary = playbackBoundary()
    const last = gate()
    const pipeline = createSpeechPipeline<string>({
      tts: vi.fn(async () => null),
      async* ttsStream() {
        yield 'first'
        yield 'second'
        await last.promise
        yield 'last'
      },
      playback: boundary.playback,
    })
    const ended = vi.fn()
    const delivered = vi.fn()
    pipeline.on('onSentencePlaybackEnd', delivered)
    pipeline.on('onTurnEnd', ended)
    const intent = pipeline.openIntent({ turnId: 'stream-test' })
    intent.writeLiteral('你好。')
    intent.end()
    await vi.waitFor(() => expect(boundary.items).toHaveLength(2))
    expect(boundary.items[0].audio).toBe('first')
    expect(boundary.items[0].text).toBe('你好。')
    expect(delivered).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
    last.release()
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce())
    expect(boundary.items.map(item => item.audio)).toEqual(['first', 'second', 'last'])
    expect(boundary.items.map(item => item.text)).toEqual(['你好。', '你好。', '你好。'])
    expect(delivered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '你好。' }))
    expect(new Set(boundary.items.map(item => item.id)).size).toBe(3)
  })

  it('cancellation drops late chunks instead of acknowledging unfinished speech', async () => {
    const boundary = playbackBoundary()
    const last = gate()
    const pipeline = createSpeechPipeline<string>({
      tts: vi.fn(async () => null),
      async* ttsStream() {
        yield 'first'
        yield 'held'
        await last.promise
        yield 'late'
      },
      playback: boundary.playback,
    })
    const delivered = vi.fn()
    pipeline.on('onSentencePlaybackEnd', delivered)
    const cancelled = vi.fn()
    pipeline.on('onTurnCancel', cancelled)
    const intent = pipeline.openIntent({ turnId: 'cancel-test' })
    intent.writeLiteral('还没有说完。')
    intent.end()
    await vi.waitFor(() => expect(boundary.items).toHaveLength(2))
    intent.cancel('host interruption')
    last.release()
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
    expect(boundary.items.map(item => item.audio)).toEqual(['first', 'held'])
    expect(delivered).not.toHaveBeenCalled()
  })

  it('keeps the original whole-audio provider when no stream is selected', async () => {
    const boundary = playbackBoundary()
    const tts = vi.fn(async () => 'whole-audio')
    const pipeline = createSpeechPipeline<string>({ tts, ttsStream: () => null, playback: boundary.playback })
    const intent = pipeline.openIntent({ turnId: 'whole-test' })
    intent.writeLiteral('普通声音。')
    intent.end()
    await vi.waitFor(() => expect(boundary.items).toHaveLength(1))
    expect(tts).toHaveBeenCalledOnce()
    expect(boundary.items[0].audio).toBe('whole-audio')
    expect(boundary.items[0].text).toBe('普通声音。')
  })
})
