import { describe, expect, it } from 'vitest'

import { RecognitionTurns } from './recognition-turns'

describe('pause-separated host speech', () => {
  it('keeps an earlier result when the host starts the next sentence', () => {
    const turns = new RecognitionTurns()
    turns.begin(1)
    turns.begin(2)
    expect(turns.complete(1, '小鲸鱼')).toBeNull()
    expect(turns.complete(2, '你听到了吗')).toEqual({ utterance: 2, text: '小鲸鱼，你听到了吗' })
    expect(turns.complete(2, 'duplicate')).toBeNull()
  })

  it('preserves speech order when provider responses arrive out of order', () => {
    const turns = new RecognitionTurns()
    turns.begin(1)
    turns.begin(2)
    expect(turns.complete(2, '后半句')).toBeNull()
    expect(turns.complete(1, '前半句')).toEqual({ utterance: 2, text: '前半句，后半句' })
  })

  it('does not release a pending sentence when a later short sound is cancelled', () => {
    const turns = new RecognitionTurns()
    turns.begin(1)
    turns.begin(2)
    expect(turns.complete(2, '')).toBeNull()
    expect(turns.complete(1, '有效句子')).toEqual({ utterance: 2, text: '有效句子' })
  })

  it('discards late results after stopping and bounds unfinished speech', () => {
    const turns = new RecognitionTurns()
    for (let id = 1; id <= 8; id++)
      expect(turns.begin(id)).toBe(true)
    expect(turns.begin(9)).toBe(false)
    turns.reset()
    turns.begin(10)
    expect(turns.complete(1, '旧会话')).toBeNull()
    expect(turns.complete(10, '新会话')).toEqual({ utterance: 10, text: '新会话' })
  })
})
