import * as v from 'valibot'

const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max))
export const coachingFields = {
  situation: text(100),
  guidance: text(180),
  scope: v.picklist(['context', 'general']),
  duration: v.picklist(['persistent', 'session']),
}
export const handbookNoteSchema = v.object({
  id: text(128),
  characterId: text(128),
  ...coachingFields,
  source: v.object({
    quote: text(2000),
    at: v.number(),
    session: text(128),
    utterance: v.nullable(v.number()),
    context: v.pipe(v.array(v.object({ role: v.picklist(['host', 'assistant']), text: text(240) })), v.maxLength(3)),
  }),
  updatedAt: v.number(),
})
/** Durable preferences are scoped to a character and guarded by a revision. */
export const handbookSchema = v.object({
  revision: text(128),
  learningEnabled: v.boolean(),
  notes: v.pipe(v.array(handbookNoteSchema), v.maxLength(192)),
})
/** The native settings surface reads the same handbook and MCP receipts as the director. */
export const directorHandbookResponseSchema = v.object({
  ...handbookSchema.entries,
  characterId: text(128),
  persistent: v.boolean(),
  error: v.nullable(v.string()),
  manual: v.string(),
  tools: v.object({
    checking: v.boolean(),
    connections: v.array(v.object({
      id: v.picklist(['live', 'web']),
      transport: v.string(),
      state: v.picklist(['idle', 'connecting', 'ready', 'error']),
      tools: v.array(v.string()),
      error: v.nullable(v.string()),
      checkedAt: v.nullable(v.number()),
    })),
    recent: v.array(v.object({
      id: v.string(),
      characterId: v.string(),
      tool: v.picklist(['live_context', 'web_search', 'web_read']),
      query: v.string(),
      at: v.number(),
      durationMs: v.number(),
      state: v.picklist(['running', 'completed', 'failed', 'cancelled']),
      summary: v.string(),
      sources: v.array(v.object({ title: v.string(), url: v.pipe(v.string(), v.url()) })),
    })),
  }),
})
export type HandbookNote = v.InferOutput<typeof handbookNoteSchema>
export type DirectorHandbookResponse = v.InferOutput<typeof directorHandbookResponseSchema>
