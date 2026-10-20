import type { Components, MotionSequence, PoseAxis, SequenceExpression, SequencePose } from '../../packages/cohost-contracts/motion.ts'

import { defaultHoldMs, parseMotionSequence as parseGenericSequence, poseLimits } from '../../packages/cohost-contracts/motion.ts'
import { componentAxes, componentBindings, componentFamilies, expressionAliases, expressionComponentAxes, expressionsConflict, handAxes, nativeExpressions } from './whale-rig.ts'

export type { MotionSequence, SequenceExpression, SequencePose } from '../../packages/cohost-contracts/motion.ts'
export { defaultHoldMs, poseLimits, sequenceDuration } from '../../packages/cohost-contracts/motion.ts'

const axes = Object.keys(poseLimits) as PoseAxis[]

/** Whale adapter validation adds model-specific switches and mutual exclusion. */
export function parseMotionSequence(value: unknown): MotionSequence | null {
  const sequence = parseGenericSequence(value)
  if (!sequence)
    return null
  for (const frame of sequence.frames) {
    if (frame.expression && !Object.hasOwn(expressionAliases, frame.expression.name) && !(nativeExpressions as readonly string[]).includes(frame.expression.name))
      return null
    for (const [key, value] of Object.entries(frame.components ?? {})) {
      if (!Object.hasOwn(componentBindings, key))
        return null
      const binding = componentBindings[key as keyof typeof componentBindings]
      if (!binding || value < (binding.min < 0 ? -1 : 0) || (binding.switch && value !== 0 && value !== 1))
        return null
    }
    if (componentFamilies.some(family => family.axes.filter(axis => frame.components?.[axis] === 1).length > 1))
      return null
  }
  return sequence
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
  let previousExpressions: SequenceExpression[] = []
  let previousComponents: Components = {}
  let elapsed = Math.max(0, elapsedMs)
  for (const [step, frame] of sequence.frames.entries()) {
    const target = { ...previous, ...frame.pose }
    const nextExpression = frame.expression
    const targetComponents = { ...previousComponents }
    let retained = previousExpressions
    const namedAxis = nextExpression && expressionComponentAxes[nextExpression.name]
    if (namedAxis)
      delete targetComponents[namedAxis]
    retained = retained.filter((item) => {
      const axis = expressionComponentAxes[item.name]
      return !axis || frame.components?.[axis] === undefined
    })
    for (const family of componentFamilies) {
      // A new named drawing replaces inherited components only in its own family.
      if (frame.expression && frame.expression.strength > 0 && family.expressions.includes(frame.expression.name)) {
        for (const axis of family.axes)
          delete targetComponents[axis]
      }
      if (family.axes.some(axis => frame.components?.[axis] === 1))
        retained = retained.filter(item => !family.expressions.includes(item.name))
    }
    Object.assign(targetComponents, frame.components)
    const newHand = handAxes.find(axis => frame.components?.[axis] === 1)
    if (!newHand && handAxes.some(axis => frame.components?.[axis] === 0) && !handAxes.some(axis => targetComponents[axis] === 1) && frame.components?.orderBoard !== 0) {
      // Lowering a special hand returns to the normal hand; explicit orderBoard=0 can hide it.
      targetComponents.orderBoard = 1
    }
    for (const family of componentFamilies) {
      const selected = family.axes.find(axis => frame.components?.[axis] === 1)
      if (selected) {
        for (const axis of family.axes)
          targetComponents[axis] = axis === selected ? 1 : 0
      }
    }
    const replaced = nextExpression ? retained.filter(item => expressionsConflict(item.name, nextExpression.name)) : []
    const independent = nextExpression ? retained.filter(item => !expressionsConflict(item.name, nextExpression.name)) : retained
    const targetExpressions = nextExpression ? [...independent, nextExpression] : retained
    const frameDuration = frame.ms + (frame.holdMs ?? defaultHoldMs)
    if (elapsed < frameDuration) {
      const progress = Math.min(1, elapsed / frame.ms)
      const ease = progress * progress * (3 - 2 * progress)
      const pose: SequencePose = {}
      for (const axis of axes) {
        if (target[axis] !== undefined)
          pose[axis] = (previous[axis] ?? 0) + ((target[axis] ?? 0) - (previous[axis] ?? 0)) * ease
      }
      const components: Components = {}
      for (const axis of componentAxes) {
        if (targetComponents[axis] === undefined)
          continue
        const from = previousComponents[axis] ?? componentBindings[axis].neutral
        const to = targetComponents[axis] ?? from
        components[axis] = componentBindings[axis].switch ? (progress < 0.5 ? from : to) : from + (to - from) * ease
      }
      // Facial transitions cannot release a prop or accessory in a different slot.
      const expressions = [...independent]
      if (nextExpression) {
        const same = replaced.find(item => item.name === nextExpression.name)
        if (same || !replaced.length) {
          const from = same?.strength ?? 0
          expressions.push({ ...nextExpression, strength: from + (nextExpression.strength - from) * ease })
        }
        else if (ease < 0.5) {
          expressions.push(...replaced.map(item => ({ ...item, strength: item.strength * (1 - ease * 2) })))
        }
        else {
          expressions.push({ ...nextExpression, strength: nextExpression.strength * (ease * 2 - 1) })
        }
      }
      return { pose, expressions, components, step: step + 1, finished: false }
    }
    elapsed -= frameDuration
    previous = target
    previousComponents = targetComponents
    previousExpressions = targetExpressions
  }
  return { pose: {} as SequencePose, expressions: [] as SequenceExpression[], components: {} as Components, step: sequence.frames.length, finished: true }
}
