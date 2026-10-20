import { defineEventa } from '@moeru/eventa'

import * as v from 'valibot'

export const entrySchema = v.object({
  id: v.number(),
  revision: v.optional(v.number()),
  role: v.string(),
  text: v.string(),
  at: v.number(),
  explanation: v.optional(v.string()),
  reason: v.optional(v.string()),
  userId: v.optional(v.string()),
  displayName: v.optional(v.string()),
  real: v.optional(v.boolean()),
  status: v.optional(v.string()),
  motionLabel: v.optional(v.string()),
  error: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  sticker: v.optional(v.object({ id: v.string(), description: v.string() })),
})
const memorySource = v.object({
  id: v.string(),
  at: v.number(),
  topic: v.number(),
  role: v.picklist(['host', 'viewer', 'assistant']),
  text: v.string(),
  characterId: v.string(),
  deliveryState: v.optional(v.picklist(['partial', 'complete', 'interrupted'])),
})
export const statusSchema = v.object({
  live: v.boolean(),
  deepseekConfigured: v.boolean(),
  busy: v.boolean(),
  muted: v.boolean(),
  hostSpeaking: v.boolean(),
  bilibili: v.object({
    source: v.string(),
    configured: v.boolean(),
    state: v.string(),
    error: v.nullable(v.string()),
    roomId: v.nullable(v.string()),
    received: v.number(),
    accepted: v.number(),
    dropped: v.number(),
  }),
  configuration: v.object({
    model: v.string(),
    persona: v.string(),
    cardId: v.string(),
    cardFingerprint: v.string(),
    profileStage: v.string(),
    profileRevision: v.string(),
    catalogRevision: v.optional(v.nullable(v.string())),
    inferenceRevision: v.optional(v.string()),
    recognitionRevision: v.optional(v.string()),
    speechRevision: v.optional(v.string()),
    recognition: v.string(),
    speech: v.string(),
    voice: v.string(),
    speechBackend: v.picklist(['aqua', 'index', 'qwen', 'siliconflow']),
  }),
  room: v.object({ session: v.string(), version: v.number(), entries: v.array(entrySchema) }),
  participation: v.optional(v.object({ busy: v.boolean() })),
  directorKnowledge: v.optional(v.object({ handbookRevision: v.string(), toolsRevision: v.number() })),
  hosting: v.optional(v.object({
    revision: v.number(),
    state: v.picklist(['off', 'observing', 'running', 'waiting', 'paused', 'completed']),
    automatic: v.boolean(),
    continuous: v.optional(v.boolean()),
    topic: v.string(),
    steps: v.number(),
    maxSteps: v.number(),
    reason: v.string(),
  })),
  // Persistence is an optional runtime capability. Memory-only test hosts omit it.
  sessionMemory: v.optional(v.object({
    enabled: v.boolean(),
    recovered: v.boolean(),
    savedAt: v.nullable(v.number()),
    error: v.nullable(v.string()),
    turns: v.number(),
    characterId: v.string(),
    continuity: v.object({
      updatedAt: v.nullable(v.number()),
      summary: v.array(memorySource),
      items: v.array(v.object({
        id: v.string(),
        characterId: v.string(),
        source: memorySource,
        text: v.string(),
        state: v.picklist(['pending', 'resumed', 'cancelled', 'expired']),
        createdAt: v.number(),
        expiresAt: v.number(),
        oldTopic: v.boolean(),
      })),
    }),
  })),
  performance: v.unknown(),
  airi: v.object({
    active: v.boolean(),
    capture: v.boolean(),
    captureReady: v.boolean(),
    ready: v.boolean(),
    configured: v.boolean(),
    control: v.optional(v.nullable(v.string())),
    error: v.optional(v.nullable(v.string())),
    stages: v.array(v.object({ stage: v.string(), owner: v.string(), ready: v.boolean() })),
  }),
})

export type Status = v.InferOutput<typeof statusSchema>
const sequence = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
const header = { epoch: v.string(), revision: sequence }
const roomChange = v.object({
  session: v.string(),
  version: sequence,
  upsert: v.array(entrySchema),
  removed: v.array(v.number()),
})
const changes = v.partial(v.omit(statusSchema, ['room', 'performance']))
export const statusFrameSchema = v.variant('kind', [
  v.object({ ...header, kind: v.literal('snapshot'), status: statusSchema }),
  v.object({ ...header, kind: v.literal('patch'), base: sequence, changes, room: v.optional(roomChange) }),
  v.object({ ...header, kind: v.literal('pulse'), performance: v.unknown() }),
])
export type StatusFrame = v.InferOutput<typeof statusFrameSchema>
export const statusEvent = defineEventa<StatusFrame>('ds-zhubo:status:v1')
export const statusMessageSchema = v.object({
  id: v.literal(statusEvent.id),
  type: v.literal('event'),
  body: statusFrameSchema,
})

/** Applies an ordered connection. A gap requires a new snapshot, never guessed state. */
export class StatusReplica {
  state: Status | undefined
  epoch: string | undefined
  revision = -1

  accept(frame: StatusFrame): Status {
    if (frame.kind === 'snapshot') {
      if (this.epoch === frame.epoch && frame.revision < this.revision)
        throw new Error('Stale status snapshot')
      this.epoch = frame.epoch
      this.revision = frame.revision
      this.state = frame.status
      return this.state
    }
    if (!this.state || frame.epoch !== this.epoch)
      throw new Error('Status snapshot required')
    if (frame.kind === 'pulse') {
      if (frame.revision !== this.revision)
        throw new Error('Status revision gap')
      this.state = { ...this.state, performance: frame.performance }
      return this.state
    }
    if (frame.revision <= this.revision)
      return this.state
    if (frame.base !== this.revision || frame.revision !== this.revision + 1)
      throw new Error('Status revision gap')
    let room = this.state.room
    if (frame.room) {
      if (frame.room.session !== room.session || frame.room.version <= room.version)
        throw new Error('Room snapshot required')
      const entries = new Map(room.entries.map(entry => [entry.id, entry]))
      for (const id of frame.room.removed) entries.delete(id)
      for (const entry of frame.room.upsert) entries.set(entry.id, entry)
      room = { session: room.session, version: frame.room.version, entries: [...entries.values()].sort((a, b) => a.id - b.id) }
    }
    this.revision = frame.revision
    this.state = { ...this.state, ...frame.changes, room }
    return this.state
  }
}
