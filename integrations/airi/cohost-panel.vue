<script setup lang="ts">
import type * as v from 'valibot'

import type { entrySchema } from './cohost-status'

import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput, Textarea } from '@proj-airi/ui'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import decisions from '../../../../i18n/src/locales/cohost/decisions.json'
import en from '../../../../i18n/src/locales/cohost/en.json'
import zh from '../../../../i18n/src/locales/cohost/zh-Hans.json'

import { cohostAccessToken, cohostControlId, cohostNeedsToken } from '../../composables/cohost-media-state'
import { syncCohostCharacter } from '../../composables/use-cohost-character'
import { cohostInput } from '../../composables/use-cohost-voice'
import { useStickersStore } from '../../stores/modules/stickers'
import { CohostClient } from './cohost-client'
import { useCohostStatus } from './use-cohost-status'

const props = defineProps<{ stage: 'web' | 'desktop' }>()
const emit = defineEmits<{ performance: [value: unknown], settings: [] }>()
const open = defineModel<boolean>('open', { default: true })
const stickers = useStickersStore()
const { t, locale } = useI18n({ useScope: 'local', messages: { en, 'zh-Hans': zh }, fallbackLocale: 'zh-Hans' })
type Entry = v.InferOutput<typeof entrySchema>
const { state, connected } = useCohostStatus()
const hostText = ref('')
const viewerText = ref('')
const role = ref<'host' | 'viewer'>('host')
const draft = computed({ get: () => role.value === 'host' ? hostText.value : viewerText.value, set: value => role.value === 'host' ? hostText.value = value : viewerText.value = value })
const token = cohostAccessToken
const needsToken = cohostNeedsToken
const error = ref('')
const sending = ref(false)
const preparingVoice = ref(false)
const hostingTopic = ref('')
const scroll = ref<HTMLElement>()

const owner = cohostControlId
let viewerNumber = 0
const processReasons = new Set(['host_voice_detected', 'transcript_updated', 'decision_consumed', 'viewer_decision_consumed', 'manual_host_override', 'mode_changed', 'viewer_window_changed'])
const entries = computed(() => state.value?.room.entries.filter(entry => !processReasons.has(entry.reason ?? '')))
const ready = computed(() => connected.value && state.value?.deepseekConfigured)
const ownVoice = computed(() => state.value?.airi.capture && state.value.airi.control === owner)
const canStartVoice = computed(() => ready.value && state.value?.airi.configured && (!state.value.airi.active || (state.value.airi.control === owner && !state.value.airi.capture)) && state.value.airi.stages.some(stage => stage.stage === props.stage && stage.owner === owner && stage.ready))
const voiceLabel = computed(() => {
  const voice = state.value?.airi
  if (!voice?.configured)
    return t('voiceMissing')
  if (!voice.active || !voice.capture)
    return t('voiceIdle')
  if (!ownVoice.value)
    return t('voiceElsewhere')
  return t(voice.captureReady ? 'voiceActive' : 'voiceStarting')
})
const activity = computed(() => {
  if (!connected.value)
    return t('offline')
  if (!state.value?.deepseekConfigured)
    return t('modelMissing')
  return t(state.value.muted ? 'muted' : state.value.hostSpeaking ? 'speaking' : state.value.busy ? 'busy' : 'waiting')
})
const client = new CohostClient(() => token.value, () => t('requestTimeout'), () => {
  needsToken.value = true
})
const api = (path: string, body?: object) => client.request(path, body)
watch(() => state.value?.performance, value => emit('performance', value), { immediate: true })
watch(() => [state.value?.room.session, state.value?.room.version], () => {
  const pinned = !scroll.value || scroll.value.scrollHeight - scroll.value.scrollTop - scroll.value.clientHeight < 70
  if (pinned)
    void latest()
})
async function latest() {
  await nextTick()
  if (scroll.value)
    scroll.value.scrollTop = scroll.value.scrollHeight
}
async function action(run: () => Promise<unknown>, exclusive = true) {
  if (exclusive && sending.value)
    return
  if (exclusive)
    sending.value = true
  error.value = ''
  try {
    await run()
  }
  catch (cause) { error.value = errorMessageFrom(cause) ?? t('offline') }
  finally {
    if (exclusive)
      sending.value = false
  }
}
async function send() {
  const text = draft.value.trim()
  const speaker = role.value
  if (!text || !ready.value)
    return
  await action(async () => {
    try {
      await syncCohostCharacter()
    }
    catch {
      throw new Error(t('characterSyncFailed'))
    }
    await api('live/start', {})
    if (!state.value?.airi.active) {
      preparingVoice.value = true
      try {
        await api('airi/start', { owner, renderer: owner, stage: props.stage, capture: false })
      }
      finally {
        preparingVoice.value = false
      }
    }
    if (speaker === 'host') {
      const utterance = Date.now()
      await api('director/event', { type: 'speech-start', utterance })
      try {
        await api('director/event', { type: 'transcript', utterance, text, final: true })
      }
      finally {
        await api('director/event', { type: 'speech-end', utterance })
      }
    }
    else {
      await api('danmaku', { id: crypto.randomUUID(), platform: 'manual', userId: `viewer-${++viewerNumber}`, text, mentioned: /小鲸鱼|助播|鲸鱼/u.test(text) })
    }
    if (speaker === 'host' && hostText.value.trim() === text)
      hostText.value = ''
    if (speaker === 'viewer' && viewerText.value.trim() === text)
      viewerText.value = ''
  })
}
function message(entry: Entry) {
  if (entry.role === 'director' && entry.reason === 'participation_error' && !entry.explanation)
    return t('decisionError')
  if (entry.role === 'director' && entry.reason === 'participation_timeout' && !entry.explanation)
    return t('decisionTimeout')
  if (entry.role === 'director')
    return entry.explanation ?? decisions[entry.reason as keyof typeof decisions] ?? t('waiting')
  return entry.text || t(entry.status === 'cancelled' ? 'cancelled' : 'thinking')
}
async function toggleVoice() {
  await action(async () => {
    if (ownVoice.value)
      return api('airi/capture', { owner, capture: false })
    await api('live/start', {})
    if (state.value?.airi.active && state.value.airi.control === owner)
      return api('airi/capture', { owner, capture: true })
    return api('airi/start', { owner, renderer: owner, stage: props.stage })
  })
}
async function controlHosting(command: 'start' | 'pause' | 'resume' | 'stop') {
  await action(async () => {
    if (command === 'start' || command === 'resume') {
      await syncCohostCharacter()
      if (!state.value?.airi.active)
        await api('airi/start', { owner, renderer: owner, stage: props.stage, capture: false })
    }
    await api('hosting', { action: command, topic: hostingTopic.value, owner, revision: state.value?.hosting?.revision })
  })
}
onUnmounted(() => {
  client.dispose()
})
</script>

<template>
  <aside data-cohost-panel data-ambient-light-opaque :class="['cohost-panel', 'text-neutral-800 dark:text-neutral-100']" :data-open="open">
    <Button v-if="!open" :aria-label="t('open')" @click="open = true">
      {{ t('open') }} · {{ ownVoice ? t('voiceActive') : t('voiceIdle') }}
    </Button>
    <div v-show="open" :class="['h-full min-h-0 flex flex-col gap-1.5 p-3', 'rounded-2xl bg-white/95 dark:bg-neutral-900/95 shadow-lg']">
      <header :class="['flex shrink-0 items-center gap-2']">
        <strong>{{ t('title') }}</strong>
        <Button size="sm" :class="['ml-auto']" @click="emit('settings')">
          {{ t('liveSettings') }}
        </Button>
        <Button size="sm" :aria-label="t('close')" @click="open = false">
          <span :class="['i-solar-alt-arrow-right-linear']" />
        </Button>
      </header>
      <p v-if="state?.sessionMemory?.error" role="alert" :class="['shrink-0 rounded-lg px-3 py-2 text-sm', 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-100']">
        {{ t('sessionMemoryError') }}
      </p>
      <div :class="['flex shrink-0 items-center justify-between gap-2']">
        <p role="status" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ activity }}
        </p>
        <Button size="sm" @click="latest">
          {{ t('latest') }}
        </Button>
      </div>
      <details v-if="state?.hosting" data-cohost-hosting :class="['shrink-0 text-sm']">
        <summary>{{ t('hostingTitle') }} · {{ t(state.hosting.state === 'off' && state.hosting.automatic ? 'hosting_auto' : `hosting_${state.hosting.state}`) }}</summary>
        <div :class="['max-h-32 flex flex-col gap-2 overflow-y-auto py-2']">
          <FieldInput v-if="state.hosting.state === 'off' || state.hosting.state === 'completed'" v-model="hostingTopic" :label="t('hostingTopic')" />
          <small v-else>
            {{ state.hosting.topic || t('hostingAutoTopic') }} · {{ state.hosting.continuous ? t('hostingContinuous') : `${state.hosting.steps}/${state.hosting.maxSteps}` }}
          </small>
          <small>{{ t(state.hosting.reason ? `hostingReason_${state.hosting.reason}` : 'hostingHint') }}</small>
          <div :class="['flex flex-wrap gap-2']">
            <Button v-if="state.hosting.state === 'off' || state.hosting.state === 'completed'" :disabled="sending || !ready || state.busy || state.muted || hostingTopic.length > 200" @click="controlHosting('start')">
              {{ t('hostingStart') }}
            </Button>
            <Button v-else-if="state.hosting.state === 'running' || state.hosting.state === 'observing'" :disabled="sending" @click="controlHosting('pause')">
              {{ t('hostingPause') }}
            </Button>
            <Button v-else :disabled="sending || !ready || state.busy || state.muted" @click="controlHosting('resume')">
              {{ t('hostingResume') }}
            </Button>
            <Button v-if="state.hosting.state !== 'off'" :disabled="sending" @click="controlHosting('stop')">
              {{ t('hostingStop') }}
            </Button>
          </div>
        </div>
      </details>
      <div v-if="needsToken" :class="['flex flex-col gap-2']">
        <FieldInput v-model="token" type="password" :label="t('token')" />
        <small>{{ t('connect') }}: {{ t('token') }}</small>
      </div>
      <div ref="scroll" role="log" :aria-label="t('title')" :class="['min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1', 'border-y border-neutral-200/60 dark:border-neutral-700/60']">
        <p v-if="!entries?.length" :class="['py-8 text-sm text-neutral-500']">
          {{ t('empty') }}
        </p>
        <article v-for="entry in entries" :key="`${state?.room.session}:${entry.id}`" v-memo="[entry, locale, stickers.artwork]" :data-role="entry.role" :class="['my-3 flex flex-col gap-1', entry.role === 'host' ? 'items-end' : 'items-start']">
          <div :class="['flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400']">
            <strong>{{ entry.role === 'host' ? t('host') : entry.role === 'viewer' ? (entry.displayName || entry.userId) : t('cohost') }}</strong>
            <span v-if="entry.role === 'viewer'">{{ entry.real ? t('biliViewer') : t('simulatedViewer') }}</span>
            <span v-if="entry.role === 'director'">{{ t('director') }}</span>
            <time>{{ new Date(entry.at).toLocaleTimeString([], { hour12: false }) }}</time>
          </div>
          <p :class="['max-w-full whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm', entry.role === 'host' ? 'bg-primary-100 dark:bg-primary-900' : entry.role === 'director' ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300' : 'bg-primary-50 dark:bg-neutral-800']">
            {{ message(entry) }}
          </p>
          <img v-if="entry.sticker && stickers.artwork[entry.sticker.id]" :src="stickers.artwork[entry.sticker.id]" :alt="entry.sticker.description" :class="['h-32 w-32 object-contain']">
          <small v-else-if="entry.sticker" :class="['text-xs text-neutral-500']">{{ t('stickerUnavailable') }}</small>
          <small v-if="entry.motionLabel || entry.status === 'cancelled' || entry.status === 'failed'" :class="['text-xs text-neutral-500']">{{ entry.motionLabel }} {{ entry.status === 'cancelled' ? t('cancelled') : entry.status === 'failed' ? t(entry.errorCode === 'speech_playback_failed' ? 'speechFailed' : 'failed') : '' }}</small>
        </article>
      </div>
      <div :class="['flex shrink-0 flex-wrap gap-2']">
        <Button size="sm" :disabled="sending || (!ownVoice && !canStartVoice)" @click="toggleVoice">
          {{ ownVoice ? t('stop') : t('start') }}
        </Button>
        <Button size="sm" color="orange" :disabled="!connected" @click="action(() => api('interrupt', {}), false)">
          {{ t('interrupt') }}
        </Button>
        <Button size="sm" :disabled="!connected" @click="action(() => api('mute', { value: !state?.muted }))">
          {{ state?.muted ? t('resume') : t('pause') }}
        </Button>
      </div>
      <small :class="['shrink-0 text-xs text-neutral-500 dark:text-neutral-400']">{{ voiceLabel }}</small>
      <div v-if="ownVoice" data-cohost-input :class="['max-h-20 flex shrink-0 flex-col gap-1 overflow-y-auto text-xs text-neutral-500 dark:text-neutral-400']">
        <div role="meter" :aria-label="t('inputVolume')" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(cohostInput.level * 100)" :class="['h-1.5 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700']">
          <div :class="['h-full rounded bg-primary-400 transition-width duration-150']" :style="{ width: `${cohostInput.level * 100}%` }" />
        </div>
        <span>{{ t(`input_${cohostInput.phase}`) }}</span>
        <span v-if="cohostInput.partial" data-cohost-partial>{{ t('recognitionPartial') }}: {{ cohostInput.partial }}</span>
        <span v-if="cohostInput.issue" :class="['text-orange-600 dark:text-orange-300']">{{ t(`inputIssue_${cohostInput.issue}`) }}</span>
        <span v-else-if="cohostInput.quiet">{{ t('inputQuiet') }}</span>
      </div>
      <div :class="['shrink-0']" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send">
        <Textarea v-model="draft" :aria-label="t(role)" :placeholder="t('placeholder')" :submit-on-enter="false" default-height="56px" :class="['max-h-24 resize-none']" />
      </div>
      <div :class="['flex shrink-0 items-center gap-2']" role="group" :aria-label="t('host')">
        <Button size="sm" :aria-pressed="role === 'host'" :variant="role === 'host' ? 'primary' : 'secondary'" @click="role = 'host'">
          {{ t('host') }}
        </Button>
        <Button size="sm" :aria-pressed="role === 'viewer'" :variant="role === 'viewer' ? 'primary' : 'secondary'" @click="role = 'viewer'">
          {{ t('viewer') }}
        </Button>
        <Button size="sm" :class="['ml-auto']" color="primary" variant="primary" :disabled="sending || !ready || !draft.trim() || draft.length > (role === 'host' ? 2000 : 500)" @click="send">
          {{ t(preparingVoice ? 'preparingVoice' : sending ? 'sending' : 'send') }}
        </Button>
      </div>
      <p v-if="error || state?.airi.error" role="alert" :class="['max-h-16 shrink-0 overflow-y-auto text-xs text-orange-600 dark:text-orange-300']">
        {{ error || state?.airi.error }}
      </p>
      <p :title="`${state?.configuration.model} · ${state?.configuration.speech}`" :class="['shrink-0 truncate text-xs text-neutral-500 dark:text-neutral-400']">
        {{ state?.configuration.model }} · {{ state?.configuration.speech }}
      </p>
    </div>
  </aside>
</template>

<style scoped>
.cohost-panel { position: absolute; right: 12px; top: 12px; bottom: 12px; width: min(480px, calc(100% - 24px)); z-index: 70; -webkit-app-region: no-drag; }
.cohost-panel[data-open='false'] { bottom: auto; width: auto; }
</style>
