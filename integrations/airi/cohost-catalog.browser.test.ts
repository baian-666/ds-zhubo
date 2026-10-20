import { PiniaColada } from '@pinia/colada'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'

import * as v from 'valibot'

import { useAiriCardStore } from '../../stores/modules/airi-card'
import { useSettingsStageModel } from '../../stores/settings/stage-model'
import { catalogValueSchema } from './cohost-catalog'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: { value: 'en' }, t: (key: string) => key }) }))

it('repository hydration in the leader replicates without follower write proposals', async () => {
  localStorage.clear()
  localStorage.setItem('cohost/enabled', 'true')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ voices: [], recommended: {}, data: [] })))
  const namespace = `cohost-catalog-${crypto.randomUUID()}`
  const leaderRuntime = createSyncedPiniaPlugin({ namespace, leadership: 'leader-only' })
  const followerRuntime = createSyncedPiniaPlugin({ namespace, leadership: 'follower-only' })
  function context(runtime: typeof leaderRuntime) {
    const pinia = createPinia()
    pinia.use(runtime.plugin)
    createApp({}).use(pinia).use(PiniaColada)
    setActivePinia(pinia)
    return { pinia, cards: useAiriCardStore(pinia) }
  }
  const leader = context(leaderRuntime)
  const follower = context(followerRuntime)
  try {
    await expect.poll(() => leaderRuntime.isLeader()).toBe(true)
    await leader.cards.initialize()
    await expect.poll(() => follower.cards.activeCard).toBeDefined()
    const value = v.parse(catalogValueSchema, {
      activeId: 'default',
      bound: true,
      cards: [{ id: 'default', data: { ...JSON.parse(JSON.stringify(leader.cards.activeCard)), name: 'Repository whale', extensions: { ...leader.cards.activeCard?.extensions, preserved: { value: 42 } } } }],
    })
    const traffic = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
    await leader.cards.applyCohostCatalog(value)
    await expect.poll(() => follower.cards.activeCard?.name).toBe('Repository whale')
    await leader.cards.applyCohostCatalog(value)
    await nextTick()
    expect(follower.cards.activeCard?.extensions.preserved).toEqual({ value: 42 })
    expect(traffic.mock.calls.filter(([message]) => JSON.stringify(message).includes('replaceState'))).toHaveLength(0)
    const stage = useSettingsStageModel(leader.pinia)
    const selected = stage.stageModelSelected
    const card = value.cards[0].data
    card.extensions = { ...card.extensions, airi: { ...leader.cards.activeCard?.extensions.airi, modules: { ...leader.cards.activeCard?.extensions.airi.modules, displayModelId: 'display-model-another-device' } } }
    await leader.cards.applyCohostCatalog(value)
    expect(stage.stageModelSelected).toBe(selected)
    expect(leader.cards.activeCard?.extensions.airi.modules.displayModelId).toBe('display-model-another-device')
    await follower.cards.reloadCohostRepository()
    await expect.poll(() => leader.cards.cohostReloadVersion).toBe(1)
  }
  finally {
    leaderRuntime.dispose()
    followerRuntime.dispose()
    disposePinia(leader.pinia)
    disposePinia(follower.pinia)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  }
})
