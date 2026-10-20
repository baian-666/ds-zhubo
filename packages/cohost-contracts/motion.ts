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
export type ExpressionName = string
export type Components = Record<string, number>
export interface SequenceExpression { name: ExpressionName, strength: number }
export interface MotionFrame { ms: number, holdMs?: number, pose: SequencePose, expression?: SequenceExpression, components?: Components }
/** A short, transient performance. Each frame has a transition and a separate hold. */
export interface MotionSequence { label: string, frames: MotionFrame[] }

export const defaultHoldMs = 800

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function within(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/**
 * Validates the shared server/renderer wire format and detaches accepted data.
 * Capability checks run separately. Raw renderer parameters and mouth opening are never pose controls.
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
    if (!object(frame) || Object.keys(frame).some(key => !['ms', 'holdMs', 'pose', 'expression', 'components'].includes(key))
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
    let components: Components | undefined
    if (frame.components !== undefined) {
      if (!object(frame.components) || Object.keys(frame.components).length > 32)
        return null
      components = {}
      for (const [key, amount] of Object.entries(frame.components)) {
        if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(key) || !within(amount, -1, 1))
          return null
        components[key] = amount
      }
    }
    let expression: SequenceExpression | undefined
    if (frame.expression !== undefined) {
      const candidate = frame.expression
      if (!object(candidate) || Object.keys(candidate).some(key => !['name', 'strength'].includes(key))
        || typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 60 || /[<>\r\n]/.test(candidate.name)
        || !within(candidate.strength, 0, 1)) {
        return null
      }
      expression = { name: candidate.name as ExpressionName, strength: candidate.strength }
    }
    transitions += frame.ms
    duration += frame.ms + (frame.holdMs as number | undefined ?? defaultHoldMs)
    if (transitions > 4000 || duration > 10000)
      return null
    frames.push({ ms: frame.ms, ...(frame.holdMs !== undefined ? { holdMs: frame.holdMs as number } : {}), pose, ...(expression ? { expression } : {}), ...(components ? { components } : {}) })
  }
  return { label: value.label.trim(), frames }
}

/** Measures a validated sequence, excluding the renderer's final release. */
export function sequenceDuration(sequence: MotionSequence): number {
  return sequence.frames.reduce((total, frame) => total + frame.ms + (frame.holdMs ?? defaultHoldMs), 0)
}
