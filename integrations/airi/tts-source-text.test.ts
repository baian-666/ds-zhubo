import { describe, expect, it } from 'vitest'

import { chunkTtsInput, TTS_FLUSH_INSTRUCTION } from './processors/tts-chunker'

describe('source-preserving speech chunks', () => {
  it('keeps a tiny opening question with its answer instead of paying for two parallel synthesis requests', async () => {
    const text = '真的？这个想法倒是挺有意思。'
    const chunks = []
    for await (const chunk of chunkTtsInput(text + TTS_FLUSH_INSTRUCTION, { preserveSourceText: true }))
      chunks.push(chunk.text)
    expect(chunks).toEqual([text])
  })
  it('keeps UTF-8 and grapheme clusters intact across byte boundaries', async () => {
    const text = '鲸鱼🐋说café。ดึก。👩‍💻👍🏽！'
    const bytes = new TextEncoder().encode(text)
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const input = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    })
    for (const byte of bytes)
      controller.enqueue(Uint8Array.of(byte))
    controller.close()
    const result = []
    for await (const chunk of chunkTtsInput(input.getReader(), { preserveSourceText: true }))
      result.push(chunk.text)
    expect(result.join('')).toBe(text)
  })
  it.each(['第一句已经完整。', '第一句已经完整', '真的吗？！'])('flushes a committed record without waiting for another record: %s', async (text) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const input = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    })
    const chunks = chunkTtsInput(input.getReader(), { preserveSourceText: true })
    controller.enqueue(new TextEncoder().encode(text + TTS_FLUSH_INSTRUCTION))
    try {
      const first = await Promise.race([
        chunks.next(),
        new Promise<null>(resolve => setTimeout(resolve, 100, null)),
      ])
      expect(first?.value?.text).toBe(text)
    }
    finally {
      controller.close()
      await chunks.return()
    }
  })
  it('emits the opening clause while the remaining text is still streaming', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const input = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    })
    const chunks = chunkTtsInput(input.getReader(), { preserveSourceText: true })
    const encoder = new TextEncoder()
    controller.enqueue(encoder.encode('行，做我自己——那我'))
    const first = await chunks.next()
    expect(first.value?.text).toBe('行，做我自己——')
    controller.enqueue(encoder.encode('就开始了。'))
    controller.close()
    const remaining = []
    for await (const chunk of chunks)
      remaining.push(chunk.text)
    expect(remaining.join('')).toBe('那我就开始了。')
  })
  // User report, 2026-10-15: speech stopped after “行，做我自己—”.
  // ROOT CAUSE:
  // The default chunker drops repeated punctuation. Exact speech authorization
  // and played-text receipts reject the changed text. Preserve source text here.
  it.each([
    '行，做我自己——那我可得提前警告你，我这张嘴不太听劝。到时候弹幕先炸了你别怪我。',
    '做我自己——那不就等于放一条鱼进你的直播间里自由发挥吗。你自己想清楚。',
    '等等……真的？！好吧...那就这样！！',
    '“你好！”她说，「今天是个好日子。」',
    '价格是1,234.50元，增加了3.14%。\r\n下一句。',
  ])('keeps exact, ordered substrings for %s', async (text) => {
    const chunks = []
    for await (const chunk of chunkTtsInput(text, { preserveSourceText: true }))
      chunks.push(chunk.text)
    let offset = 0
    for (const chunk of chunks) {
      const start = text.indexOf(chunk, offset)
      expect(start).toBeGreaterThanOrEqual(offset)
      expect(text.slice(offset, start).trim()).toBe('')
      expect(chunk).toMatch(/[\p{L}\p{N}]/u)
      offset = start + chunk.length
    }
    expect(text.slice(offset).trim()).toBe('')
  })
})
