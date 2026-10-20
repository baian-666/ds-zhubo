import { expect, it, vi } from 'vitest'

import { StreamingRecognition } from './streaming-recognition'

it('uses native browser fetch to receive a completed recognition stream', async () => {
  const frame = `${JSON.stringify({ type: 'final', text: '小鲸鱼你好', asrMs: 1 })}\n`
  const origin = `data:application/x-ndjson,${encodeURIComponent(frame)}#`
  const final = vi.fn()
  const error = vi.fn()
  const segment = new StreamingRecognition(origin, {}, 1, vi.fn(), final, error)
  try {
    segment.end()
    await vi.waitFor(() => expect(final).toHaveBeenCalledExactlyOnceWith('小鲸鱼你好'))
    expect(error).not.toHaveBeenCalled()
  }
  finally { segment.cancel() }
})
