import type { MotionSequence } from './motion-sequence'

import { defineEventa } from '@moeru/eventa'

import * as v from 'valibot'

import { parseMotionSequence } from './motion-sequence'

export const commandSchema = v.pipe(v.object({
  session: v.pipe(v.string(), v.maxLength(100)),
  id: v.pipe(v.number(), v.integer(), v.minValue(0)),
  name: v.picklist(['idle', 'listen', 'think', 'nod', 'smile', 'surprise', 'pout', 'sequence']),
  expiresAt: v.pipe(v.number(), v.finite()),
  startedAt: v.optional(v.nullable(v.pipe(v.number(), v.finite()))),
  motion: v.optional(v.custom<MotionSequence>(value => parseMotionSequence(value) !== null)),
}), v.check(command => command.name !== 'sequence' || (command.motion !== undefined && command.startedAt !== undefined)))
export type Command = v.InferOutput<typeof commandSchema>
export interface Receipt { ready: boolean, expression?: string, name: Command['name'], session: string, id: number, label?: string, step?: number, waiting?: boolean }
export const commandEvent = defineEventa<Command>('cohost:performance')
export const receiptEvent = defineEventa<Receipt>('cohost:receipt')
export const channel = 'ds-zhubo-performance-v1'
