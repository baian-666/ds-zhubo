<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'

import * as v from 'valibot'

import en from '../../../../i18n/src/locales/cohost/en.json'
import zh from '../../../../i18n/src/locales/cohost/zh-Hans.json'
import CohostDirectorSettings from './cohost-director-settings.vue'

import { cohostAccessToken, cohostNeedsToken } from '../../composables/cohost-media-state'
import { useAiriCardStore } from '../../stores/modules/airi-card'
import { useSettingsAudioDevice } from '../../stores/settings/audio-device'
import { CohostClient } from './cohost-client'
import { useCohostStatus } from './use-cohost-status'

const { t } = useI18n({ useScope: 'local', messages: { en, 'zh-Hans': zh }, fallbackLocale: 'zh-Hans' })
const audioSettings = useSettingsAudioDevice()
const cards = useAiriCardStore()
const cardFingerprint = ref('')
const cardBound = useLocalStorage('cohost/use-airi-card', false)
const selectedMicrophone = computed(
  () =>
    audioSettings.audioInputOptions.find(input => input.value === audioSettings.selectedAudioInput)?.label
    || (audioSettings.selectedAudioInput && audioSettings.selectedAudioInput !== 'default'
      ? t('savedMicrophone')
      : t('systemMicrophone')),
)
const { state, connected } = useCohostStatus()
const token = cohostAccessToken
const needsToken = cohostNeedsToken
const error = ref('')
const sending = ref(false)
const resetSession = ref<string>()
const client = new CohostClient(
  () => token.value,
  () => t('requestTimeout'),
  () => {
    needsToken.value = true
  },
)
const api = (path: string, body?: object) => client.request(path, body)
const biliActive = computed(() => ['connecting', 'connected', 'retrying'].includes(state.value?.bilibili.state ?? ''))
async function useCurrentCard() {
  if (!cards.systemPrompt.trim())
    throw new Error(t('emptyCard'))
  cardBound.value = true
}
async function migrateWhale() {
  const original = cards.activeCard
  if (!original)
    return
  const saved = localStorage.getItem('cohost/whale-card-id')
  if (saved && cards.cards.has(saved)) {
    await cards.activateCard(saved)
  }
  else {
    const data = v.parse(v.object({ name: v.string(), prompt: v.string() }), await api('character/default'))
    const extensions = { ...original.extensions }
    if (extensions.airi) {
      const modules = { ...extensions.airi.modules }
      for (const key of ['consciousness', 'vision', 'speech', 'artistry'] as const) {
        const selection = modules[key]
        if (selection?.provider && !selection.model)
          Object.assign(modules, { [key]: { ...selection, provider: '' } })
      }
      extensions.airi = { ...extensions.airi, modules }
    }
    const id = await cards.addCard({ ...original, extensions, name: data.name, systemPrompt: '', description: '', personality: data.prompt, scenario: '', greetings: [], messageExample: [], postHistoryInstructions: '' }, 'duplicate')
    localStorage.setItem('cohost/whale-card-id', id)
    await cards.activateCard(id)
  }
  await useCurrentCard()
}

watch(() => cards.systemPrompt, async (prompt, _, cleanup) => {
  let active = true
  cleanup(() => {
    active = false
  })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt))
  if (active)
    cardFingerprint.value = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}, { immediate: true })
async function action(run: () => Promise<unknown>) {
  if (sending.value)
    return
  sending.value = true
  error.value = ''
  try {
    await run()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('offline')
  }
  finally {
    sending.value = false
  }
}
async function toggleBilibili() {
  await action(async () => {
    if (biliActive.value) {
      await api('bilibili/stop', {})
      return
    }
    await api('live/start', {})
    await api('bilibili/start', {})
  })
}

async function clearSession() {
  await action(async () => {
    if (!resetSession.value)
      return
    await api('reset', { session: resetSession.value })
    resetSession.value = undefined
  })
}
async function updateMemory(operation: 'clear-summary' | 'remove-item', id?: string) {
  const current = state.value
  if (!current?.sessionMemory)
    return
  const body = { action: operation, id, session: current.room.session, characterId: current.sessionMemory.characterId }
  await action(() => api('session-memory', body))
}
function memoryTime(at: number) {
  return new Date(at).toLocaleString()
}

onUnmounted(() => {
  client.dispose()
})
</script>

<template>
  <section :class="['flex flex-col gap-4 pb-8']">
    <p>{{ t('settingsOwnership') }}</p>
    <div :class="['flex flex-col gap-2']">
      <strong>{{ t('characterTitle') }}</strong>
      <p>{{ t('selectedCard', { name: cards.activeCard?.name ?? '' }) }}</p>
      <p>{{ cardBound ? t('cardBound') : t('cardUnbound') }}</p>
      <p>{{ t('cardRepository') }}</p>
      <p v-if="cards.cohostRepositoryError" role="alert">
        {{ cards.cohostRepositoryError }}
      </p>
      <Button v-if="cards.cohostRepositoryError" @click="cards.reloadCohostRepository()">
        {{ t('cardReload') }}
      </Button>
      <p v-if="cardBound">
        {{ state?.configuration.cardId === cards.activeCardId && state.configuration.cardFingerprint === cardFingerprint ? t('cardApplied') : t('cardPending') }}
      </p>
      <div :class="['flex flex-wrap gap-2']">
        <Button :disabled="sending || !connected" @click="action(migrateWhale)">
          {{ t('migrateWhale') }}
        </Button>
        <Button :disabled="sending || !connected" @click="action(useCurrentCard)">
          {{ t('useCurrentCard') }}
        </Button>
        <RouterLink to="/settings/airi-card">
          {{ t('editCards') }}
        </RouterLink>
      </div>
    </div>
    <p v-if="!connected" role="status">
      {{ t('offline') }}
    </p>
    <FieldInput v-if="needsToken" v-model="token" type="password" :label="t('token')" />
    <p v-if="error" role="alert">
      {{ error }}
    </p>
    <p>{{ t('model') }}: {{ state?.configuration.model }} · {{ t('persona') }}: {{ state?.configuration.persona }}</p>
    <RouterLink to="/settings/modules/consciousness">
      {{ t('inferenceOpen') }}
    </RouterLink>
    <p>
      {{ t('configVoice') }}: {{ state?.configuration.recognition }} / {{ state?.configuration.speech }} ·
      {{ state?.configuration.voice }}
    </p>
    <RouterLink to="/settings/modules/speech">
      {{ t('speechOpen') }}
    </RouterLink>
    <p>{{ t('configDevice', { device: selectedMicrophone }) }} · {{ t('voiceTip') }}</p>
    <p>{{ t('configNote') }}</p>
    <CohostDirectorSettings />
    <div v-if="state?.sessionMemory" data-session-memory :class="['flex flex-col gap-2']">
      <strong>{{ t('sessionMemoryTitle') }}</strong>
      <p v-if="state.sessionMemory.error" role="alert">
        {{ t('sessionMemoryError') }}
      </p>
      <p v-else-if="state.sessionMemory.enabled">
        {{ state.sessionMemory.recovered ? t('sessionMemoryRecovered') : t('sessionMemorySaved') }}
      </p>
      <p v-else>
        {{ t('sessionMemoryDisabled') }}
      </p>
      <p>{{ t('sessionMemoryScope', { turns: state.sessionMemory.turns }) }}</p>
      <details data-session-continuity>
        <summary>{{ t('continuityTitle') }}</summary>
        <div :class="['mt-3 flex flex-col gap-3']">
          <p>{{ t('summaryPolicy') }}</p>
          <p v-if="!state.sessionMemory.continuity.summary.length">
            {{ t('summaryEmpty') }}
          </p>
          <div v-for="source in state.sessionMemory.continuity.summary" :key="source.id" :class="['border rounded-lg p-3']">
            <p :class="['text-sm opacity-70']">
              {{ t(`memorySource_${source.role}`) }} · {{ memoryTime(source.at) }} · {{ t('memoryTopic', { topic: source.topic }) }}
              <span v-if="source.deliveryState && source.deliveryState !== 'complete'"> · {{ t('memoryPartial') }}</span>
            </p>
            <p :class="['whitespace-pre-wrap break-words']">
              {{ source.text }}
            </p>
          </div>
          <Button :disabled="sending || !connected || !state.sessionMemory.continuity.summary.length" @click="updateMemory('clear-summary')">
            {{ t('summaryClear') }}
          </Button>
          <strong>{{ t('continuationTitle') }}</strong>
          <p>{{ t('continuationPolicy') }}</p>
          <p v-if="!state.sessionMemory.continuity.items.length">
            {{ t('continuationEmpty') }}
          </p>
          <div v-for="item in state.sessionMemory.continuity.items" :key="item.id" data-continuation-item :class="['flex flex-col gap-2 border rounded-lg p-3']">
            <p>{{ item.text }} · {{ t(`continuation_${item.state}`) }}</p>
            <p v-if="item.oldTopic && item.state === 'pending'">
              {{ t('continuationOldTopic') }}
            </p>
            <p :class="['text-sm opacity-70']">
              {{ t('memorySource_host') }} · {{ memoryTime(item.source.at) }}
            </p>
            <p :class="['whitespace-pre-wrap break-words']">
              {{ item.source.text }}
            </p>
            <p v-if="item.state === 'pending'">
              {{ t('continuationExpires', { time: memoryTime(item.expiresAt) }) }}
            </p>
            <Button :class="['self-start']" :disabled="sending || !connected" @click="updateMemory('remove-item', item.id)">
              {{ t('continuationRemove') }}
            </Button>
          </div>
        </div>
      </details>
      <Button v-if="!resetSession" :disabled="sending || !connected" @click="resetSession = state?.room.session">
        {{ t('sessionMemoryClear') }}
      </Button>
      <template v-else>
        <p>{{ t('sessionMemoryConfirm') }}</p>
        <div :class="['flex flex-wrap gap-2']">
          <Button :disabled="sending || !connected" @click="clearSession">
            {{ t('sessionMemoryConfirmClear') }}
          </Button>
          <Button :disabled="sending" @click="resetSession = undefined">
            {{ t('sessionMemoryKeep') }}
          </Button>
        </div>
      </template>
    </div>
    <div data-bilibili :class="['mt-2 flex flex-col gap-2']">
      <strong>{{ t('biliTitle') }} · {{ t(`bili_${state?.bilibili.state ?? 'disconnected'}`) }}</strong>
      <span v-if="state?.bilibili.source === 'blivechat'">{{ t('biliLocalRelay') }}</span>
      <span v-if="!state?.bilibili.configured">{{ t('biliMissing') }}</span>
      <a v-if="!state?.bilibili.configured" href="http://127.0.0.1:8791/" target="_blank" rel="noopener noreferrer">{{
        t('biliSetup')
      }}</a>
      <span v-if="state?.bilibili.error">{{ t(`biliError_${state.bilibili.error}`) }}</span>
      <span v-if="state?.bilibili.roomId">{{ t('biliRoom', { room: state.bilibili.roomId }) }}</span>
      <span>{{
        t('biliCount', { accepted: state?.bilibili.accepted ?? 0, dropped: state?.bilibili.dropped ?? 0 })
      }}</span>
      <Button :disabled="sending || !connected || (!biliActive && !state?.bilibili.configured)" @click="toggleBilibili">
        {{ biliActive ? t('biliStop') : t('biliStart') }}
      </Button>
    </div>

    <div :class="['flex flex-wrap gap-4']">
      <RouterLink to="/settings/modules/hearing">
        {{ t('nativeMicrophone') }}
      </RouterLink>
      <RouterLink to="/settings/modules/stickers">
        {{ t('nativeStickers') }}
      </RouterLink>
      <RouterLink to="/settings/models">
        {{ t('nativeModel') }}
      </RouterLink>
    </div>
  </section>
</template>
