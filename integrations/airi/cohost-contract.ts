import { defineEventa } from '@moeru/eventa'

import * as v from 'valibot'

export const commandSchema = v.object({
  session: v.pipe(v.string(), v.maxLength(100)),
  id: v.pipe(v.number(), v.integer(), v.minValue(0)),
  name: v.picklist(['idle', 'listen', 'think', 'nod', 'smile', 'surprise', 'pout']),
  expiresAt: v.number(),
})
export type Command = v.InferOutput<typeof commandSchema>
export interface Receipt { ready: boolean, name: Command['name'], session: string, id: number }
export const commandEvent = defineEventa<Command>('cohost:performance')
export const receiptEvent = defineEventa<Receipt>('cohost:receipt')
export const channel = 'ds-zhubo-performance-v1'
