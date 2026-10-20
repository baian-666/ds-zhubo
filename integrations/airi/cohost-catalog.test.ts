import { describe, expect, it } from 'vitest'

import { CatalogReplica } from './cohost-catalog'

const value = { activeId: 'default', bound: true, cards: [{ id: 'default', data: { name: 'Whale', version: '1', extensions: { custom: { kept: true } } } }] }
describe('character repository replica', () => {
  it('does not treat object key order as an edit', async () => {
    let writes = 0
    const replica = new CatalogReplica(async (_, body) => {
      if (body)
        writes++
      return { catalog: { revision: 'r1', value } }
    })
    await replica.reconcile(value, 'r1')
    await replica.reconcile({ cards: value.cards, bound: value.bound, activeId: value.activeId }, 'r1')
    expect(writes).toBe(0)
  })
  it('imports once and does not publish replicated snapshots', async () => {
    let saved: { revision: string, value: typeof value } | null = null
    let writes = 0
    const replica = new CatalogReplica(async (_, body) => {
      if (body) {
        writes++
        saved = { revision: 'r1', value }
      }
      return { catalog: saved }
    })
    expect(await replica.reconcile(value, null)).toEqual(value)
    await replica.reconcile(value, 'r1')
    expect(writes).toBe(1)
  })
  it('loads remote edits without sending them back', async () => {
    let remote = { revision: 'r1', value }
    let writes = 0
    const replica = new CatalogReplica(async (_, body) => {
      if (body)
        writes++
      return { catalog: remote }
    })
    await replica.reconcile(value, 'r1')
    remote = { revision: 'r2', value: { ...value, bound: false } }
    expect(await replica.reconcile(value, 'r2')).toEqual(remote.value)
    await replica.reconcile(remote.value, 'r2')
    expect(writes).toBe(0)
  })
  it('preserves the local draft on conflict and retries with the same base revision', async () => {
    const revisions: unknown[] = []
    const replica = new CatalogReplica(async (_, body) => {
      if (body) {
        revisions.push(Reflect.get(body, 'revision'))
        throw new Error('conflict')
      }
      return { catalog: { revision: 'r1', value } }
    })
    await replica.reconcile(value, 'r1')
    const draft = { ...value, bound: false }
    await expect(replica.reconcile(draft, 'r2')).rejects.toThrow('conflict')
    await expect(replica.reconcile(draft, 'r2')).rejects.toThrow('conflict')
    expect(revisions).toEqual(['r1', 'r1'])
    expect(draft.bound).toBe(false)
  })
})
