import type { MotionSequence, PoseAxis } from './motion.ts'

import * as v from 'valibot'

import { parseMotionSequence, poseLimits } from './motion.ts'

const name = v.pipe(v.string(), v.minLength(1), v.maxLength(60), v.regex(/^[^<>\r\n]+$/))
const axis = v.pipe(v.string(), v.regex(/^[a-z][a-zA-Z0-9]{0,39}$/))
const bounded = v.pipe(v.number(), v.finite(), v.minValue(-1), v.maxValue(1))
const presets = ['idle', 'listen', 'think', 'nod', 'smile', 'surprise', 'pout'] as const
const componentSchema = v.strictObject({
  name: axis,
  min: bounded,
  max: bounded,
  discrete: v.boolean(),
  description: v.pipe(v.string(), v.maxLength(100)),
})

/** Effective capabilities include operator permissions. They contain no renderer parameter IDs. */
export const capabilitiesSchema = v.pipe(v.strictObject({
  version: v.literal(1),
  adapter: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
  modelId: v.pipe(v.string(), v.maxLength(200)),
  presets: v.pipe(v.array(v.picklist(presets)), v.maxLength(7)),
  poses: v.pipe(v.array(v.picklist(Object.keys(poseLimits) as PoseAxis[])), v.maxLength(10)),
  expressions: v.pipe(v.array(name), v.maxLength(100)),
  aliases: v.pipe(v.array(v.strictObject({ name: v.picklist(['smile', 'think', 'surprise', 'pout']), expression: name })), v.maxLength(4)),
  components: v.pipe(v.array(componentSchema), v.maxLength(32)),
  exclusive: v.pipe(v.array(v.pipe(v.array(axis), v.minLength(2), v.maxLength(8))), v.maxLength(8)),
}), v.check(value => new Set(value.expressions).size === value.expressions.length
  && new Set(value.components.map(item => item.name)).size === value.components.length
  && new Set(value.aliases.map(item => item.name)).size === value.aliases.length
  && value.aliases.every(item => value.expressions.includes(item.expression))
  && value.components.every(item => item.min < item.max && (!item.discrete || (item.min === 0 && item.max === 1)))
  && value.exclusive.every(group => new Set(group).size === group.length && group.every(key => value.components.some(item => item.name === key && item.discrete)))))
export type PerformanceCapabilities = v.InferOutput<typeof capabilitiesSchema>

export function emptyCapabilities(modelId = ''): PerformanceCapabilities {
  return { version: 1, adapter: 'none', modelId, presets: ['idle'], poses: [], expressions: [], aliases: [], components: [], exclusive: [] }
}

export const targetSchema = v.strictObject({ modelId: v.pipe(v.string(), v.maxLength(200)), revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{16}$/)) })
export type PerformanceTarget = v.InferOutput<typeof targetSchema>

/** This fingerprint identifies a capability snapshot. It is not an authentication token. */
export function performanceTarget(capabilities: PerformanceCapabilities): PerformanceTarget {
  const text = JSON.stringify(capabilities)
  let first = 2166136261
  let second = 3339675911
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619)
    second = Math.imul(second ^ text.charCodeAt(index), 2246822519)
  }
  return { modelId: capabilities.modelId, revision: [first, second].map(value => (value >>> 0).toString(16).padStart(8, '0')).join('') }
}

export function sameTarget(a: PerformanceTarget | undefined, b: PerformanceTarget | undefined) {
  return !!a && !!b && a.modelId === b.modelId && a.revision === b.revision
}

export interface PerformanceIntent { performance?: string, motion?: MotionSequence }

export interface PerformanceCommand {
  name: string
  motion?: MotionSequence
  target?: PerformanceTarget
  expiresAt: number
  startedAt?: number | null
  issues?: string[]
}

/** The renderer checks the target again. A stale action cannot acquire parameter ownership. */
export function evaluatePerformance(command: PerformanceCommand, capabilities: PerformanceCapabilities, now: number) {
  if (!sameTarget(command.target, performanceTarget(capabilities)))
    return { performance: 'idle', motion: undefined, outcome: 'stale' as const, issues: ['stale-capabilities'] }
  const result = constrainPerformance({ performance: command.name, motion: command.motion }, capabilities)
  const issues = [...new Set([...(command.issues ?? []), ...result.issues])].slice(0, 32)
  const active = !!result.motion || result.performance !== 'idle'
  let outcome: 'idle' | 'unsupported' | 'waiting' | 'partial' | 'applied' = 'applied'
  if (command.expiresAt <= now)
    outcome = 'idle'
  else if (!active)
    outcome = issues.length ? 'unsupported' : 'idle'
  else if (command.startedAt === null)
    outcome = 'waiting'
  else if (issues.length)
    outcome = 'partial'
  return { ...result, performance: command.expiresAt <= now ? 'idle' : result.motion ? 'sequence' : result.performance, outcome, issues } as const
}

/** Drop unsupported controls without changing spoken text or waiting for the renderer. */
export function constrainPerformance(intent: PerformanceIntent, capabilities: PerformanceCapabilities) {
  const issues: string[] = []
  let performance = intent.performance ?? 'idle'
  if (performance !== 'sequence' && !capabilities.presets.includes(performance as typeof presets[number])) {
    issues.push(`preset:${performance}`)
    performance = 'idle'
  }
  let motion = intent.motion && parseMotionSequence(intent.motion)
  if (intent.motion && !motion)
    issues.push('invalid-motion')
  if (motion) {
    motion = { ...motion, frames: motion.frames.map((frame) => {
      const pose = { ...frame.pose }
      for (const key of Object.keys(pose) as PoseAxis[]) {
        if (!capabilities.poses.includes(key)) {
          delete pose[key]
          issues.push(`pose:${key}`)
        }
      }
      let expression = frame.expression
      const resolved = capabilities.aliases.find(item => item.name === expression?.name)?.expression ?? expression?.name
      if (expression && !capabilities.expressions.includes(resolved!)) {
        issues.push(`expression:${expression.name}`)
        expression = undefined
      }
      let components = frame.components && { ...frame.components }
      for (const [key, value] of Object.entries(components ?? {})) {
        const binding = capabilities.components.find(item => item.name === key)
        if (!binding || value < binding.min || value > binding.max || (binding.discrete && value !== 0 && value !== 1)) {
          delete components![key]
          issues.push(`component:${key}`)
        }
      }
      for (const group of capabilities.exclusive) {
        if (group.filter(key => components?.[key] === 1).length > 1) {
          for (const key of group)
            delete components![key]
          issues.push(`conflict:${group.join(',')}`)
        }
      }
      if (!Object.keys(components ?? {}).length)
        components = undefined
      return { ...frame, pose, expression, components }
    }) }
    if (!motion.frames.some(frame => Object.keys(frame.pose).length || frame.expression || Object.keys(frame.components ?? {}).length)) {
      motion = null
      issues.push('empty-motion')
    }
  }
  if (performance === 'sequence' && !motion)
    performance = 'idle'
  return { performance, motion: motion ?? undefined, issues: [...new Set(issues)].slice(0, 32) }
}

export function motionSequenceSchema(capabilities: PerformanceCapabilities) {
  return {
    type: 'object',
    properties: {
      label: { type: 'string', maxLength: 24 },
      frames: { type: 'array', minItems: 1, maxItems: 4, items: {
        type: 'object',
        properties: {
          ms: { type: 'integer', minimum: 200, maximum: 1800 },
          holdMs: { type: 'integer', minimum: 0, maximum: 1800 },
          pose: { type: 'object', properties: Object.fromEntries(capabilities.poses.map(key => [key, { type: 'number', minimum: poseLimits[key][0], maximum: poseLimits[key][1] }])), additionalProperties: false },
          ...(capabilities.expressions.length ? { expression: { type: 'object', properties: { name: { type: 'string', enum: [...capabilities.expressions, ...capabilities.aliases.map(item => item.name)] }, strength: { type: 'number', minimum: 0, maximum: 1 } }, required: ['name', 'strength'], additionalProperties: false } } : {}),
          ...(capabilities.components.length ? { components: { type: 'object', properties: Object.fromEntries(capabilities.components.map(item => [item.name, { type: 'number', minimum: item.min, maximum: item.max, ...(item.discrete ? { enum: [0, 1] } : {}), description: item.description }])), additionalProperties: false } } : {}),
        },
        required: ['ms', 'pose'],
        additionalProperties: false,
      } },
    },
    required: ['label', 'frames'],
    additionalProperties: false,
  }
}
