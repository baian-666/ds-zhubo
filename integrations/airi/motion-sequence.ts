/** Allowed normalized body controls. Speech owns mouth opening. */
export const poseLimits = {
  eyeX: [-1, 1],
  eyeY: [-1, 1],
  eyeSquint: [0, 0.8],
  headX: [-0.65, 0.65],
  headY: [-0.65, 0.65],
  headZ: [-0.65, 0.65],
  bodyX: [-0.35, 0.35],
  bodyY: [-0.35, 0.35],
  bodyZ: [-0.35, 0.35],
  mouthForm: [-0.8, 0.8],
} as const

export type PoseAxis = keyof typeof poseLimits
export type SequencePose = Partial<Record<PoseAxis, number>>
export type ExpressionName = 'smile' | 'think' | 'surprise' | 'pout'
export interface SequenceExpression { name: ExpressionName, strength: number }
export interface MotionFrame { ms: number, holdMs?: number, pose: SequencePose, expression?: SequenceExpression }
/** A short, transient performance. Each frame has a transition and a separate hold. */
export interface MotionSequence { label: string, frames: MotionFrame[] }

export const defaultHoldMs = 800

const expressionNames = ['smile', 'think', 'surprise', 'pout']
const axes = Object.keys(poseLimits) as PoseAxis[]
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function within(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/**
 * Validates the shared server/renderer wire format and detaches accepted data.
 * Unknown controls fail closed. No arbitrary model parameters or mouth opening cross this boundary.
 * @example
 * parseMotionSequence({ label: '侧目', frames: [{ ms: 600, pose: { eyeX: 0.5 } }] })
 * // => { label: '侧目', frames: [{ ms: 600, pose: { eyeX: 0.5 } }] }
 */
export function parseMotionSequence(value: unknown): MotionSequence | null {
  if (!object(value) || Object.keys(value).some(key => !['label', 'frames'].includes(key))
    || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 24
    || /[<>\r\n]/.test(value.label) || !Array.isArray(value.frames) || value.frames.length < 1 || value.frames.length > 4) {
    return null
  }
  const frames: MotionFrame[] = []
  let duration = 0
  let transitions = 0
  for (const frame of value.frames) {
    if (!object(frame) || Object.keys(frame).some(key => !['ms', 'holdMs', 'pose', 'expression'].includes(key))
      || !within(frame.ms, 200, 1800) || !Number.isInteger(frame.ms) || !object(frame.pose)) {
      return null
    }
    if (frame.holdMs !== undefined && (!within(frame.holdMs, 0, 1800) || !Number.isInteger(frame.holdMs)))
      return null
    const pose: SequencePose = {}
    for (const [key, amount] of Object.entries(frame.pose)) {
      if (!Object.hasOwn(poseLimits, key))
        return null
      const axis = key as PoseAxis
      if (!within(amount, poseLimits[axis][0], poseLimits[axis][1]))
        return null
      pose[axis] = amount
    }
    let expression: SequenceExpression | undefined
    if (frame.expression !== undefined) {
      const candidate = frame.expression
      if (!object(candidate) || Object.keys(candidate).some(key => !['name', 'strength'].includes(key))
        || typeof candidate.name !== 'string' || !expressionNames.includes(candidate.name)
        || !within(candidate.strength, 0, 1)) {
        return null
      }
      expression = { name: candidate.name as ExpressionName, strength: candidate.strength }
    }
    transitions += frame.ms
    duration += frame.ms + (frame.holdMs as number | undefined ?? defaultHoldMs)
    if (transitions > 4000 || duration > 10000)
      return null
    frames.push({ ms: frame.ms, ...(frame.holdMs !== undefined ? { holdMs: frame.holdMs as number } : {}), pose, ...(expression ? { expression } : {}) })
  }
  return { label: value.label.trim(), frames }
}

/** Measures a validated sequence, excluding the renderer's final release. */
export function sequenceDuration(sequence: MotionSequence): number {
  return sequence.frames.reduce((total, frame) => total + frame.ms + (frame.holdMs ?? defaultHoldMs), 0)
}

/**
 * Samples a validated sequence from a shared start time. Polling never restarts its phase.
 * Sparse pose targets retain earlier values. Each transition uses a smooth ease curve.
 * @example
 * sampleMotionSequence({ label: '侧目', frames: [{ ms: 600, pose: { eyeX: 0.6 } }] }, 300).pose.eyeX
 * // => 0.3
 */
export function sampleMotionSequence(sequence: MotionSequence, elapsedMs: number) {
  let previous: SequencePose = {}
  let expression: SequenceExpression | undefined
  let elapsed = Math.max(0, elapsedMs)
  for (const [step, frame] of sequence.frames.entries()) {
    const target = { ...previous, ...frame.pose }
    const nextExpression = frame.expression ?? expression
    const frameDuration = frame.ms + (frame.holdMs ?? defaultHoldMs)
    if (elapsed < frameDuration) {
      const progress = Math.min(1, elapsed / frame.ms)
      const ease = progress * progress * (3 - 2 * progress)
      const pose: SequencePose = {}
      for (const axis of axes)
        pose[axis] = (previous[axis] ?? 0) + ((target[axis] ?? 0) - (previous[axis] ?? 0)) * ease
      let sampledExpression: SequenceExpression | undefined
      if (nextExpression) {
        if (!expression || expression.name === nextExpression.name) {
          const from = expression?.strength ?? 0
          sampledExpression = { name: nextExpression.name, strength: from + (nextExpression.strength - from) * ease }
        }
        else {
          sampledExpression = ease < 0.5
            ? { name: expression.name, strength: expression.strength * (1 - ease * 2) }
            : { name: nextExpression.name, strength: nextExpression.strength * (ease * 2 - 1) }
        }
      }
      return { pose, expression: sampledExpression, step: step + 1, finished: false }
    }
    elapsed -= frameDuration
    previous = target
    expression = nextExpression
  }
  return { pose: {} as SequencePose, expression: undefined, step: sequence.frames.length, finished: true }
}

/** Describes exactly the controls accepted by parseMotionSequence for model tool calling. */
export const motionSequenceSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: 24, description: '本次动作的简短中文描述' },
    frames: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          ms: { type: 'integer', minimum: 200, maximum: 1800, description: '过渡到目标所需毫秒' },
          holdMs: { type: 'integer', minimum: 0, maximum: 1800, description: '到位后停留毫秒，省略默认800，常用800–1400' },
          pose: {
            type: 'object',
            properties: Object.fromEntries(axes.map(axis => [axis, { type: 'number', minimum: poseLimits[axis][0], maximum: poseLimits[axis][1] }])),
            additionalProperties: false,
          },
          expression: {
            type: 'object',
            properties: { name: { type: 'string', enum: expressionNames }, strength: { type: 'number', minimum: 0, maximum: 1 } },
            required: ['name', 'strength'],
            additionalProperties: false,
          },
        },
        required: ['ms', 'pose'],
        additionalProperties: false,
      },
    },
  },
  required: ['label', 'frames'],
  additionalProperties: false,
}
