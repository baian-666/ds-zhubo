import * as v from 'valibot'

const cardSchema = v.looseObject({ name: v.string(), version: v.string(), extensions: v.optional(v.record(v.string(), v.unknown())) })
export const catalogValueSchema = v.object({ activeId: v.string(), bound: v.boolean(), cards: v.array(v.object({ id: v.string(), data: cardSchema })) })
const responseSchema = v.object({ catalog: v.nullable(v.object({ revision: v.string(), value: catalogValueSchema })) })
export type CatalogValue = v.InferOutput<typeof catalogValueSchema>

/** Object key order cannot turn a replicated card into another edit. */
function signature(value: CatalogValue) {
  return JSON.stringify(value, (_, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    return item
  })
}

/** Edits carry the version loaded by this renderer. Remote changes never silently overwrite a dirty draft. */
export class CatalogReplica {
  private revision: string | null | undefined
  private baseline = ''

  constructor(private readonly request: (path: string, body?: object) => Promise<unknown>) {}

  async reconcile(draft: CatalogValue, remoteRevision: string | null | undefined): Promise<CatalogValue | undefined> {
    const current = signature(draft)
    if (this.revision === undefined) {
      let response = v.parse(responseSchema, await this.request('characters'))
      if (!response.catalog)
        response = v.parse(responseSchema, await this.request('characters', { revision: null, value: draft }))
      if (!response.catalog)
        throw new Error('Character catalog was not saved')
      this.revision = response.catalog.revision
      this.baseline = signature(response.catalog.value)
      return response.catalog.value
    }
    if (current !== this.baseline) {
      const response = v.parse(responseSchema, await this.request('characters', { revision: this.revision, value: draft }))
      if (!response.catalog)
        throw new Error('Character catalog was not saved')
      this.revision = response.catalog.revision
      this.baseline = signature(response.catalog.value)
      return
    }
    if (remoteRevision && remoteRevision !== this.revision) {
      const response = v.parse(responseSchema, await this.request('characters'))
      if (!response.catalog)
        throw new Error('Character catalog was not found')
      this.revision = response.catalog.revision
      this.baseline = signature(response.catalog.value)
      return response.catalog.value
    }
  }

  reload() {
    this.revision = undefined
  }
}
