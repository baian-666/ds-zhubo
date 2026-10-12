<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput, FieldTextArea } from '@proj-airi/ui'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import * as v from 'valibot'

import decisions from '../../../../i18n/src/locales/cohost/decisions.json'
import en from '../../../../i18n/src/locales/cohost/en.json'
import zh from '../../../../i18n/src/locales/cohost/zh-Hans.json'

import { cohostInput } from '../../composables/use-cohost-voice'

const props = defineProps<{ stage: 'web' | 'desktop' }>()
const emit = defineEmits<{ performance: [value: unknown] }>()
const open = defineModel<boolean>('open', { default: true })
const { t } = useI18n({ useScope: 'local', messages: { en, 'zh-Hans': zh }, fallbackLocale: 'zh-Hans' })
const entrySchema = v.object({
  id: v.number(),
  role: v.string(),
  text: v.string(),
  at: v.number(),
  explanation: v.optional(v.string()),
  reason: v.optional(v.string()),
  userId: v.optional(v.string()),
  status: v.optional(v.string()),
  motionLabel: v.optional(v.string()),
  error: v.optional(v.string()),
})
const statusSchema = v.object({
  live: v.boolean(),
  deepseekConfigured: v.boolean(),
  busy: v.boolean(),
  muted: v.boolean(),
  hostSpeaking: v.boolean(),
  configuration: v.object({ model: v.string(), persona: v.string(), recognition: v.string(), speech: v.string(), voice: v.string() }),
  room: v.object({ session: v.string(), version: v.number(), entries: v.array(entrySchema) }),
  performance: v.unknown(),
  airi: v.object({
    active: v.boolean(),
    ready: v.boolean(),
    configured: v.boolean(),
    control: v.optional(v.nullable(v.string())),
    error: v.optional(v.nullable(v.string())),
    stages: v.array(v.object({ stage: v.string(), ready: v.boolean() })),
  }),
})
type Entry = v.InferOutput<typeof entrySchema>
const state = ref<v.InferOutput<typeof statusSchema>>()
const hostText = ref('')
const viewerText = ref('')
const role = ref<'host' | 'viewer'>('host')
const draft = computed({ get: () => role.value === 'host' ? hostText.value : viewerText.value, set: value => role.value === 'host' ? hostText.value = value : viewerText.value = value })
const token = ref('')
const needsToken = ref(false)
const error = ref('')
const connected = ref(false)
const sending = ref(false)
const scroll = ref<HTMLElement>()
const pending = new Set<AbortController>()
const origin = 'http://127.0.0.1:8787'
// The panel owns only its microphone lease. The server owns decisions and reply execution.
// Collapsing preserves the lease. Navigation releases it and cancels panel requests.
const owner = crypto.randomUUID()
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let viewerNumber = 0
const processReasons = new Set(['host_voice_detected', 'transcript_updated', 'decision_consumed', 'viewer_decision_consumed', 'manual_host_override', 'mode_changed', 'viewer_window_changed'])
const entries = computed(() => state.value?.room.entries.filter(entry => !processReasons.has(entry.reason ?? '')))
const ready = computed(() => connected.value && state.value?.deepseekConfigured)
const ownVoice = computed(() => state.value?.airi.active && state.value.airi.control === owner)
const canStartVoice = computed(() => ready.value && state.value?.airi.configured && !state.value.airi.active && state.value.airi.stages.some(stage => stage.stage === props.stage && stage.ready))
const voiceLabel = computed(() => {
  const voice = state.value?.airi
  if (!voice?.configured)
    return t('voiceMissing')
  if (!voice.active)
    return t('voiceIdle')
  if (!ownVoice.value)
    return t('voiceElsewhere')
  return t(voice.ready ? 'voiceActive' : 'voiceStarting')
})
const activity = computed(() => {
  if (!connected.value)
    return t('offline')
  if (!state.value?.deepseekConfigured)
    return t('modelMissing')
  return t(state.value.muted ? 'muted' : state.value.hostSpeaking ? 'speaking' : state.value.busy ? 'busy' : 'waiting')
})
function headers() {
  const value: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token.value)
    value.Authorization = `Bearer ${token.value}`
  return value
}
async function api(path: string, body?: object): Promise<unknown> {
  const controller = new AbortController()
  pending.add(controller)
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${origin}/api/${path}`, { method: body ? 'POST' : 'GET', headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: controller.signal })
    if (response.status === 401)
      needsToken.value = true
    const data: unknown = await response.json()
    if (!response.ok) {
      const result = v.safeParse(v.object({ error: v.string() }), data)
      throw new Error(result.success ? result.output.error : t('offline'))
    }
    return data
  }
  finally {
    clearTimeout(timeout)
    pending.delete(controller)
  }
}
async function refresh() {
  try {
    const next = v.parse(statusSchema, await api('status'))
    if (disposed)
      return
    const pinned = !scroll.value || scroll.value.scrollHeight - scroll.value.scrollTop - scroll.value.clientHeight < 70
    const changed = next.room.session !== state.value?.room.session || next.room.version !== state.value?.room.version
    state.value = next
    connected.value = true
    needsToken.value = false
    emit('performance', next.performance)
    if (pinned && changed)
      await latest()
  }
  catch {
    connected.value = false
  }
  finally {
    if (!disposed)
      timer = setTimeout(refresh, connected.value ? 400 : 1800)
  }
}
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
    await api('live/start', {})
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
  if (entry.role === 'director' && entry.reason === 'participation_error')
    return t('decisionError')
  if (entry.role === 'director' && entry.reason === 'participation_timeout')
    return t('decisionTimeout')
  if (entry.role === 'director')
    return entry.explanation ?? decisions[entry.reason as keyof typeof decisions] ?? t('waiting')
  return entry.text || t(entry.status === 'cancelled' ? 'cancelled' : 'thinking')
}
async function toggleVoice() {
  await action(async () => {
    if (ownVoice.value)
      return api('airi/stop', { owner })
    await api('live/start', {})
    return api('airi/start', { owner, stage: props.stage })
  })
}
function releaseVoice() {
  if (state.value?.airi.control === owner)
    void fetch(`${origin}/api/airi/stop`, { method: 'POST', headers: headers(), body: JSON.stringify({ owner }), keepalive: true }).catch(() => {})
}
onMounted(() => {
  void refresh()
  window.addEventListener('pagehide', releaseVoice)
})
onUnmounted(() => {
  disposed = true
  clearTimeout(timer)
  for (const controller of pending)
    controller.abort()
  releaseVoice()
  window.removeEventListener('pagehide', releaseVoice)
})
</script>

<template>
  <aside data-cohost-panel data-ambient-light-opaque :class="['cohost-panel', 'text-neutral-800 dark:text-neutral-100']" :data-open="open">
    <Button v-if="!open" :aria-label="t('open')" @click="open = true">
      {{ t('open') }} · {{ ownVoice ? t('voiceActive') : t('voiceIdle') }}
    </Button>
    <div v-show="open" :class="['h-full min-h-0 flex flex-col gap-3 p-4', 'rounded-2xl bg-white/95 dark:bg-neutral-900/95 shadow-lg']">
      <header :class="['flex items-center justify-between gap-2']">
        <strong>{{ t('title') }}</strong>
        <Button :aria-label="t('close')" @click="open = false">
          <span :class="['i-solar-alt-arrow-right-linear']" />
        </Button>
      </header>
      <p role="status" :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ activity }}
      </p>
      <div v-if="needsToken" :class="['flex flex-col gap-2']">
        <FieldInput v-model="token" type="password" :label="t('token')" />
        <small>{{ t('connect') }}: {{ t('token') }}</small>
      </div>
      <div ref="scroll" role="log" :aria-label="t('title')" :class="['min-h-20 flex-1 overflow-y-auto overscroll-contain pr-1']">
        <p v-if="!entries?.length" :class="['py-8 text-sm text-neutral-500']">
          {{ t('empty') }}
        </p>
        <article v-for="entry in entries" :key="`${state?.room.session}:${entry.id}`" :data-role="entry.role" :class="['my-3 flex flex-col gap-1', entry.role === 'host' ? 'items-end' : 'items-start']">
          <div :class="['flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400']">
            <strong>{{ entry.role === 'host' ? t('host') : entry.role === 'viewer' ? entry.userId : t('cohost') }}</strong>
            <span v-if="entry.role === 'director'">{{ t('director') }}</span>
            <time>{{ new Date(entry.at).toLocaleTimeString([], { hour12: false }) }}</time>
          </div>
          <p :class="['max-w-full whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm', entry.role === 'host' ? 'bg-primary-100 dark:bg-primary-900' : entry.role === 'director' ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300' : 'bg-primary-50 dark:bg-neutral-800']">
            {{ message(entry) }}
          </p>
          <small v-if="entry.motionLabel || entry.status === 'cancelled' || entry.status === 'failed'" :class="['text-xs text-neutral-500']">{{ entry.motionLabel }} {{ entry.status === 'cancelled' ? t('cancelled') : entry.status === 'failed' ? t('failed') : '' }}</small>
        </article>
      </div>
      <Button :class="['self-end text-xs']" @click="latest">
        {{ t('latest') }}
      </Button>
      <div :class="['flex flex-wrap gap-2']">
        <Button :disabled="sending || (!ownVoice && !canStartVoice)" @click="toggleVoice">
          {{ ownVoice ? t('stop') : t('start') }}
        </Button>
        <Button color="orange" :disabled="!connected" @click="action(() => api('interrupt', {}), false)">
          {{ t('interrupt') }}
        </Button>
        <Button :disabled="!connected" @click="action(() => api('mute', { value: !state?.muted }))">
          {{ state?.muted ? t('resume') : t('pause') }}
        </Button>
      </div>
      <small :class="['text-xs text-neutral-500']">{{ voiceLabel }}</small>
      <div v-if="ownVoice" data-cohost-input :class="['flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400']">
        <div role="meter" :aria-label="t('inputVolume')" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(cohostInput.level * 100)" :class="['h-1.5 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700']">
          <div :class="['h-full rounded bg-primary-400 transition-width duration-150']" :style="{ width: `${cohostInput.level * 100}%` }" />
        </div>
        <span>{{ t(`input_${cohostInput.phase}`) }}</span>
        <span v-if="cohostInput.issue" :class="['text-orange-600 dark:text-orange-300']">{{ t(`inputIssue_${cohostInput.issue}`) }}</span>
        <span v-else-if="cohostInput.quiet">{{ t('inputQuiet') }}</span>
      </div>
      <div :class="['flex gap-2']" role="group" :aria-label="t('host')">
        <Button :variant="role === 'host' ? 'primary' : 'secondary'" @click="role = 'host'">
          {{ t('host') }}
        </Button>
        <Button :variant="role === 'viewer' ? 'primary' : 'secondary'" @click="role = 'viewer'">
          {{ t('viewer') }}
        </Button>
      </div>
      <div @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send">
        <FieldTextArea v-model="draft" :label="t(role)" :placeholder="t('placeholder')" :rows="2" :required="false" textarea-class="resize-none max-h-30" />
      </div>
      <Button color="primary" variant="primary" :disabled="sending || !ready || !draft.trim() || draft.length > (role === 'host' ? 2000 : 500)" @click="send">
        {{ t('send') }}
      </Button>
      <p v-if="error || state?.airi.error" role="alert" :class="['text-xs text-orange-600 dark:text-orange-300']">
        {{ error || state?.airi.error }}
      </p>
      <details :class="['max-h-36 shrink-0 overflow-auto text-xs text-neutral-500 dark:text-neutral-400']">
        <summary :class="['cursor-pointer']">
          {{ t('settings') }}
        </summary>
        <p>{{ t('model') }}: {{ state?.configuration.model }} · {{ t('persona') }}: {{ state?.configuration.persona }}</p>
        <p>{{ t('configVoice') }}: {{ state?.configuration.recognition }} / {{ state?.configuration.speech }} · {{ state?.configuration.voice }}</p>
        <p>{{ t('configDevice', { device: cohostInput.device || t('systemMicrophone') }) }} · {{ t('voiceTip') }}</p>
        <p>{{ t('configNote') }}</p>
        <p>{{ t('tip') }}</p>
      </details>
    </div>
  </aside>
</template>

<style scoped>
.cohost-panel { position: absolute; right: 12px; top: 12px; bottom: 12px; width: min(400px, calc(100% - 24px)); z-index: 70; -webkit-app-region: no-drag; }
.cohost-panel[data-open='false'] { bottom: auto; width: auto; }
@media (max-height: 650px) { .cohost-panel[data-open='true'] { overflow: auto; } .cohost-panel > div { min-height: 600px; } }
</style>
