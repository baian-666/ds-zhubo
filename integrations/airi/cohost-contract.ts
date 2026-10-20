import type { MotionSequence } from '../../packages/cohost-contracts/motion.ts'

import { defineEventa } from '@moeru/eventa'

import * as v from 'valibot'

import { parseMotionSequence } from '../../packages/cohost-contracts/motion.ts'
import { targetSchema } from '../../packages/cohost-contracts/performance.ts'

export const commandSchema = v.pipe(v.object({
  session: v.pipe(v.string(), v.maxLength(100)),
  id: v.pipe(v.number(), v.integer(), v.minValue(0)),
  name: v.picklist(['idle', 'listen', 'think', 'nod', 'smile', 'surprise', 'pout', 'sequence']),
  expiresAt: v.pipe(v.number(), v.finite()),
  startedAt: v.optional(v.nullable(v.pipe(v.number(), v.finite()))),
  audioId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  motion: v.optional(v.custom<MotionSequence>(value => parseMotionSequence(value) !== null)),
  target: v.optional(targetSchema),
  issues: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(200))), v.maxLength(32))),
}), v.check(command => command.name !== 'sequence' || (command.motion !== undefined && command.startedAt !== undefined)))
export type Command = v.InferOutput<typeof commandSchema>
export interface Receipt { ready: boolean, expression?: string, name: Command['name'], session: string, id: number, label?: string, step?: number, waiting?: boolean, outcome: 'applied' | 'partial' | 'unsupported' | 'stale' | 'waiting' | 'idle' | 'unavailable' | 'failed', issues: string[] }
export const commandEvent = defineEventa<Command>('cohost:performance')
export const receiptEvent = defineEventa<Receipt>('cohost:receipt')
export const channel = 'ds-zhubo-performance-v1'
