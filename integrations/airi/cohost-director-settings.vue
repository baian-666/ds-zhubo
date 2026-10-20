<script setup lang="ts">
import type { DirectorHandbookResponse, HandbookNote } from './cohost-director-contract'

import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput, FieldSelect, FieldTextArea } from '@proj-airi/ui'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import * as v from 'valibot'

import en from '../../../../i18n/src/locales/cohost/en.json'
import zh from '../../../../i18n/src/locales/cohost/zh-Hans.json'

import { cohostAccessToken, cohostNeedsToken } from '../../composables/cohost-media-state'
import { CohostClient } from './cohost-client'
import { directorHandbookResponseSchema } from './cohost-director-contract'
import { useCohostStatus } from './use-cohost-status'

const { t } = useI18n({ useScope: 'local', messages: { en, 'zh-Hans': zh }, fallbackLocale: 'zh-Hans' })
const { state, connected } = useCohostStatus()
const data = ref<DirectorHandbookResponse>()
const error = ref('')
const busy = ref(false)
const draft = ref<{
  id?: string
  revision: string
  characterId: string
  situation: string
  guidance: string
  scope: HandbookNote['scope']
  duration: HandbookNote['duration']
}>()
const client = new CohostClient(() => cohostAccessToken.value, () => t('requestTimeout'), () => {
  cohostNeedsToken.value = true
})
let generation = 0
let disposed = false
const scopes = computed(() => ['context', 'general'].map(value => ({ label: t(`director.scope_${value}`), value })))
const durations = computed(() => ['persistent', 'session'].map(value => ({ label: t(`director.duration_${value}`), value })))
const saveReady = computed(() => draft.value && draft.value.situation.trim() && draft.value.situation.length <= 100 && draft.value.guidance.trim() && draft.value.guidance.length <= 180)
async function load() {
  if (!connected.value || busy.value)
    return
  const request = ++generation
  try {
    const value = v.parse(directorHandbookResponseSchema, await client.request('director-handbook'))
    if (!disposed && request === generation) {
      data.value = value
      error.value = ''
    }
  }
  catch (cause) {
    if (!disposed && request === generation)
      error.value = errorMessageFrom(cause) ?? t('offline')
  }
}
async function action(path: string, body: object, clearDraft = false) {
  if (busy.value)
    return
  const request = ++generation
  busy.value = true
  error.value = ''
  try {
    const value = v.parse(directorHandbookResponseSchema, await client.request(path, body))
    if (!disposed && request === generation) {
      data.value = value
      if (clearDraft)
        draft.value = undefined
    }
  }
  catch (cause) {
    if (!disposed && request === generation)
      error.value = errorMessageFrom(cause) ?? t('offline')
  }
  finally {
    if (!disposed) {
      busy.value = false
      if (request !== generation)
        void load()
    }
  }
}
function edit(note?: HandbookNote) {
  if (!data.value)
    return
  draft.value = {
    id: note?.id,
    revision: data.value.revision,
    characterId: data.value.characterId,
    situation: note?.situation ?? '',
    guidance: note?.guidance ?? '',
    scope: note?.scope ?? 'context',
    duration: note?.duration ?? 'persistent',
  }
}
function save() {
  if (!draft.value || !saveReady.value)
    return
  const { revision, characterId, ...change } = draft.value
  return action('director-handbook', { revision, characterId, change: { ...change, operation: change.id ? 'revise' : 'remember' } }, true)
}
function remove(id: string) {
  if (!data.value)
    return
  return action('director-handbook', { revision: data.value.revision, characterId: data.value.characterId, change: { operation: 'forget', id } })
}
function toggleLearning() {
  if (!data.value)
    return
  return action('director-handbook', { revision: data.value.revision, characterId: data.value.characterId, operation: 'learning', enabled: !data.value.learningEnabled })
}
function time(at: number) {
  return new Date(at).toLocaleString()
}
watch(() => state.value?.configuration.cardId, () => {
  generation++
  data.value = undefined
  draft.value = undefined
  void load()
})
watch(() => [connected.value, cohostAccessToken.value, state.value?.directorKnowledge?.handbookRevision, state.value?.directorKnowledge?.toolsRevision], () => {
  void load()
}, { immediate: true })
onUnmounted(() => {
  disposed = true
  generation++
  client.dispose()
})
</script>

<template>
  <section data-director-settings :class="['flex flex-col gap-3 border rounded-xl p-4']">
    <h2 :class="['text-lg font-semibold']">
      {{ t('director.title') }}
    </h2>
    <p>{{ t('director.intro') }}</p>
    <p v-if="error" role="alert">
      {{ error }}
    </p>
    <div :class="['flex flex-wrap gap-2']">
      <Button :disabled="busy || !connected" @click="load">
        {{ t('director.refresh') }}
      </Button>
      <Button :disabled="busy || !connected" @click="action('director-tools/check', {})">
        {{ t('director.check') }}
      </Button>
    </div>
    <template v-if="data">
      <div :class="['grid gap-2 sm:grid-cols-2']">
        <div v-for="connection in data.tools.connections" :key="connection.id" :class="['border rounded-lg p-3']">
          <strong>{{ t(`director.connection_${connection.id}`) }}</strong>
          <p role="status">
            {{ t(`director.state_${connection.state}`) }}
            <span v-if="connection.checkedAt"> · {{ time(connection.checkedAt) }}</span>
          </p>
          <p v-if="connection.error" role="alert">
            {{ connection.error }}
          </p>
        </div>
      </div>
      <p :class="['text-sm opacity-70']">
        {{ t('director.queryPolicy') }}
      </p>
      <details data-director-queries>
        <summary>{{ t('director.queries') }} · {{ data.tools.recent.length }}</summary>
        <div :class="['mt-3 flex flex-col gap-3']">
          <p v-if="!data.tools.recent.length">
            {{ t('director.noQueries') }}
          </p>
          <article v-for="item in data.tools.recent" :key="item.id" :class="['flex flex-col gap-2 border rounded-lg p-3']">
            <strong>{{ t(`director.tool_${item.tool}`) }} · {{ t(`director.state_${item.state}`) }}</strong>
            <p :class="['text-sm opacity-70']">
              {{ time(item.at) }} · {{ (item.durationMs / 1000).toFixed(1) }} s
            </p>
            <p :class="['break-words']">
              {{ item.query }}
            </p>
            <p :class="['whitespace-pre-wrap break-words text-sm']">
              {{ item.summary }}
            </p>
            <a v-for="source in item.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer" :class="['break-all underline']">{{ source.title }} · {{ source.url }}</a>
          </article>
        </div>
      </details>
      <details data-director-manual>
        <summary>{{ t('director.manual') }}</summary>
        <pre :class="['mt-3 whitespace-pre-wrap break-words text-sm font-sans']">{{ data.manual }}</pre>
      </details>
      <h3 :class="['font-semibold']">
        {{ t('director.feedback') }} · {{ data.notes.length }}/24
      </h3>
      <p>{{ data.persistent ? t('director.persisted') : t('director.temporary') }}</p>
      <p v-if="data.error" role="alert">
        {{ data.error }}
      </p>
      <div :class="['flex flex-wrap gap-2']">
        <Button :disabled="busy || !connected || !!draft" @click="toggleLearning">
          {{ data.learningEnabled ? t('director.pauseLearning') : t('director.resumeLearning') }}
        </Button>
        <Button :disabled="busy || !connected || !!draft || data.notes.length >= 24" @click="edit()">
          {{ t('director.add') }}
        </Button>
      </div>
      <p>{{ data.learningEnabled ? t('director.learningOn') : t('director.learningOff') }}</p>
      <form v-if="draft" data-director-edit :class="['flex flex-col gap-3 border rounded-lg p-3']" @submit.prevent="save">
        <FieldInput v-model="draft.situation" :label="t('director.situation')" />
        <FieldTextArea v-model="draft.guidance" :label="t('director.guidance')" :rows="3" />
        <FieldSelect v-model="draft.scope" :label="t('director.scope')" :options="scopes" />
        <FieldSelect v-model="draft.duration" :label="t('director.duration')" :options="durations" />
        <p v-if="draft.revision !== data.revision" role="status">
          {{ t('director.conflict') }}
        </p>
        <div :class="['flex flex-wrap gap-2']">
          <Button :disabled="busy || !connected || !saveReady || draft.revision !== data.revision" @click="save">
            {{ t('director.save') }}
          </Button>
          <Button :disabled="busy" @click="draft = undefined">
            {{ t('director.cancel') }}
          </Button>
        </div>
      </form>
      <p v-if="!data.notes.length">
        {{ t('director.empty') }}
      </p>
      <article v-for="note in data.notes" :key="note.id" data-director-note :class="['flex flex-col gap-2 border rounded-lg p-3']">
        <strong>{{ note.situation }}</strong>
        <p :class="['whitespace-pre-wrap break-words']">
          {{ note.guidance }}
        </p>
        <p :class="['text-sm opacity-70']">
          {{ t(`director.scope_${note.scope}`) }} · {{ t(`director.duration_${note.duration}`) }} · {{ time(note.updatedAt) }}
        </p>
        <details>
          <summary>{{ t('director.source') }}</summary>
          <blockquote :class="['mt-2 whitespace-pre-wrap break-words']">
            {{ note.source.quote }}
          </blockquote>
          <p v-for="(context, index) in note.source.context" :key="index" :class="['mt-2 text-sm opacity-70']">
            {{ t(`memorySource_${context.role}`) }}：{{ context.text }}
          </p>
        </details>
        <div :class="['flex flex-wrap gap-2']">
          <Button :disabled="busy || !connected || !!draft" @click="edit(note)">
            {{ t('director.edit') }}
          </Button>
          <Button :disabled="busy || !connected || !!draft" @click="remove(note.id)">
            {{ t('director.remove') }}
          </Button>
        </div>
      </article>
    </template>
  </section>
</template>
