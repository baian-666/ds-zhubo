import { describe, expect, it } from 'vitest'

import { parseMotionSequence, sampleMotionSequence } from './motion-sequence'

describe('cohost motion sequence', () => {
  it('uses elapsed time and sparse targets without controlling speech mouth opening', () => {
    const sequence = parseMotionSequence({ label: '侧目', frames: [
      { ms: 600, pose: { eyeX: 0.6, headZ: 0.2 } },
      { ms: 600, pose: { eyeX: -0.6 } },
    ] })
    expect(sequence).not.toBeNull()
    if (!sequence)
      throw new Error('Fixture rejected')
    expect(sampleMotionSequence(sequence, 300).pose.eyeX).toBeCloseTo(0.3)
    expect(sampleMotionSequence(sequence, 900).pose.eyeX).toBeCloseTo(0)
    expect(sampleMotionSequence(sequence, 900).pose.headZ).toBeCloseTo(0.2)
    expect(sampleMotionSequence(sequence, 1200).finished).toBe(true)
    expect(parseMotionSequence({ label: '无效', frames: [{ ms: 500, pose: { mouthOpen: 1 } }] })).toBeNull()
  })

  it('fades out one native expression before bringing in another', () => {
    const sequence = parseMotionSequence({ label: '转笑', frames: [
      { ms: 600, pose: {}, expression: { name: 'pout', strength: 0.8 } },
      { ms: 600, pose: {}, expression: { name: 'smile', strength: 0.6 } },
    ] })
    if (!sequence)
      throw new Error('Fixture rejected')
    expect(sampleMotionSequence(sequence, 750).expression?.name).toBe('pout')
    expect(sampleMotionSequence(sequence, 900).expression?.strength).toBe(0)
    expect(sampleMotionSequence(sequence, 1050).expression?.name).toBe('smile')
    expect(sampleMotionSequence(sequence, 1050).expression?.strength).toBeGreaterThan(0)
  })
})
