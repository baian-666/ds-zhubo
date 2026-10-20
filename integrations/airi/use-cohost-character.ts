import { errorMessageFrom } from '@moeru/std'
import { useSettingsLive2d } from '@proj-airi/stage-ui-live2d/composables/live2d'
import { useExpressionStore } from '@proj-airi/stage-ui-live2d/stores'
import { useLocalStorage } from '@vueuse/core'
import { onMounted, onUnmounted, watch } from 'vue'

import * as v from 'valibot'

import { CatalogReplica, catalogValueSchema } from '../components/scenarios/cohost-catalog'
import { CohostClient } from '../components/scenarios/cohost-client'
import { useCohostStatus } from '../components/scenarios/use-cohost-status'
import { whaleCapabilities } from '../components/scenarios/whale-capabilities'
import { useAiriCardStore } from '../stores/modules/airi-card'
import { useStickersStore } from '../stores/modules/stickers'
import { useSettingsStageModel } from '../stores/settings/stage-model'
import { cohostAccessToken, cohostControlId, cohostNeedsToken } from './cohost-media-state'

class CharacterSync {
  private readonly cards = useAiriCardStore()
  private readonly stickers = useStickersStore()
  private readonly expressions = useExpressionStore()
  private readonly live2d = useSettingsLive2d()
  private readonly model = useSettingsStageModel()
  private readonly bound = useLocalStorage('cohost/use-airi-card', false)
  private readonly client = new CohostClient(() => cohostAccessToken.value, () => 'Character sync timed out', () => { cohostNeedsToken.value = true })
  private readonly catalog = new CatalogReplica((path, body) => this.client.request(path, body))
  private readonly status = useCohostStatus()
  private signature = ''
  private syncedAt = 0
  private pending: Promise<void> | undefined
  private disposed = false
  private timer: ReturnType<typeof setInterval> | undefined
  private unwatch: (() => void) | undefined
  private reloadVersion = 0
  private draftChangedDuringLoad = false

  constructor(private readonly stage: 'desktop' | 'web') {}

  private snapshot() {
    const card = this.cards.activeCard
    return {
      profile: {
        stage: this.stage,
        owner: cohostControlId,
        card: this.bound.value && card ? { id: this.cards.activeCardId, name: card.name, prompt: this.cards.systemPrompt } : null,
        capabilities: whaleCapabilities(this.expressions, this.live2d.live2dExpressionEnabled, this.model.stageModelRenderer),
      },
      stickers: { stage: this.stage, owner: cohostControlId, enabled: this.stickers.enabled, frequency: this.stickers.frequency, entries: this.stickers.entries.slice(0, 48).map(entry => ({ id: entry.assetId, description: `${entry.name}: ${entry.emotions.join(', ')}`.slice(0, 60) })) },
    }
  }

  sync() {
    if (!this.pending)
      this.pending = this.publish().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async publish() {
    while (!this.disposed) {
      if (!this.cards.cards.has('default') || !this.cards.activeCard)
        return
      const draft = v.parse(catalogValueSchema, { activeId: this.cards.activeCardId, bound: this.bound.value, cards: Array.from(this.cards.cards, ([id, data]) => ({ id, data })) })
      if (this.reloadVersion !== this.cards.cohostReloadVersion) {
        localStorage.setItem('cohost/cards-unsaved-draft', JSON.stringify(draft))
        this.catalog.reload()
        this.reloadVersion = this.cards.cohostReloadVersion
        this.draftChangedDuringLoad = false
      }
      if (this.draftChangedDuringLoad)
        throw new Error('Character draft changed during synchronization. Reload saved cards to continue.')
      const next = await this.catalog.reconcile(draft, this.status.state.value?.configuration.catalogRevision)
      if (next && !this.disposed) {
        const current = v.parse(catalogValueSchema, { activeId: this.cards.activeCardId, bound: this.bound.value, cards: Array.from(this.cards.cards, ([id, data]) => ({ id, data })) })
        if (JSON.stringify(current) !== JSON.stringify(draft)) {
          this.draftChangedDuringLoad = true
          throw new Error('Character draft changed during synchronization. Reload saved cards to continue.')
        }
        if (!localStorage.getItem('cohost/cards-before-repository'))
          localStorage.setItem('cohost/cards-before-repository', JSON.stringify(draft))
        await this.cards.applyCohostCatalog(next)
        this.bound.value = next.bound
      }
      if (this.cards.cohostRepositoryError)
        await this.cards.setCohostRepositoryError('')
      const body = this.snapshot()
      const signature = JSON.stringify(body)
      if (signature === this.signature && Date.now() - this.syncedAt < 5000)
        return
      await this.client.request('runtime-profile', body.profile)
      await this.client.request('stickers', body.stickers)
      this.signature = signature
      this.syncedAt = Date.now()
      // Re-read after I/O so an edit made during a request is applied before send resolves.
    }
  }

  mount() {
    const sync = () => {
      void this.sync().catch(async (error) => {
        const message = errorMessageFrom(error) ?? 'Character synchronization failed'
        if (this.cards.cohostRepositoryError !== message)
          await this.cards.setCohostRepositoryError(message)
      })
    }
    this.unwatch = watch([() => JSON.stringify(this.snapshot()), () => JSON.stringify(Array.from(this.cards.cards)), () => this.cards.cohostReloadVersion, () => this.status.state.value?.configuration.catalogRevision, cohostAccessToken], sync, { immediate: true })
    this.timer = setInterval(sync, 5000)
  }

  dispose() {
    this.disposed = true
    clearInterval(this.timer)
    this.unwatch?.()
    this.client.dispose()
  }
}

let active: CharacterSync | undefined

/** Wait for the root-owned metadata publication before submitting a new message. */
export function syncCohostCharacter() {
  if (!active)
    throw new Error('Character controller is unavailable')
  return active.sync()
}

/** The renderer root publishes metadata. Settings windows only edit the native stores. */
export function useCohostCharacter(stage: 'desktop' | 'web') {
  const controller = new CharacterSync(stage)
  active = controller
  onMounted(() => controller.mount())
  onUnmounted(() => {
    controller.dispose()
    if (active === controller)
      active = undefined
  })
}
