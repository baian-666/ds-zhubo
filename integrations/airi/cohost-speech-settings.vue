<script setup lang="ts">
import type { EffectiveSpeechConfig } from './cohost-speech-contract'

import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput, FieldSelect } from '@proj-airi/ui'
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import * as v from 'valibot'

import en from '../../../../i18n/src/locales/cohost/en.json'
import zh from '../../../../i18n/src/locales/cohost/zh-Hans.json'

import { cohostAccessToken, cohostNeedsToken } from '../../composables/cohost-media-state'
import { CohostClient } from './cohost-client'
import { useCohostStatus } from './use-cohost-status'

const { t } = useI18n({ useScope: 'local', messages: { en, 'zh-Hans': zh }, fallbackLocale: 'zh-Hans' })
const capabilities = v.object({ transport: v.picklist(['pcm-stream', 'wav']), reference: v.boolean(), emotion: v.boolean() })
const schema = v.object({
  effective: v.object({ schemaVersion: v.literal(1), revision: v.string(), engine: v.picklist(['index', 'aqua', 'qwen', 'siliconflow']), voice: v.string(), model: v.string(), capabilities }),
  providers: v.array(v.object({ id: v.string(), model: v.string(), voices: v.array(v.string()), capabilities })),
  busy: v.boolean(),
  preview: v.boolean(),
  persistence: v.object({ storage: v.picklist(['sqlite', 'memory']), savedAt: v.nullable(v.number()) }),
})
const configuration = shallowRef<v.InferOutput<typeof schema>>()
const effective = computed<EffectiveSpeechConfig | undefined>(() => configuration.value?.effective)
const providers = computed(() => configuration.value?.providers.map(item => ({ label: item.model, value: item.id })))
const voices = computed(() => configuration.value?.providers.find(item => item.id === effective.value?.engine)?.voices.map(value => ({ label: value, value })))
const token = cohostAccessToken
const needsToken = cohostNeedsToken
const pending = ref(false)
const connected = ref(false)
const status = useCohostStatus()
const error = ref('')
const notice = ref('')
const client = new CohostClient(() => token.value, () => t('requestTimeout'), () => {
  needsToken.value = true
})
let disposed = false
let generation = 0

async function refresh() {
  const current = ++generation
  const next = v.parse(schema, await client.request('speech/config'))
  if (!disposed && current === generation) {
    configuration.value = next
    connected.value = true
    needsToken.value = false
  }
}
async function update() {
  try {
    if (!pending.value)
      await refresh()
  }
  catch { connected.value = false }
}
async function action(run: () => Promise<unknown>) {
  if (pending.value)
    return
  pending.value = true
  generation++
  notice.value = ''
  error.value = ''
  try {
    await run()
  }
  catch (cause) { error.value = errorMessageFrom(cause) ?? t('offline') }
  finally {
    await refresh().catch(() => {
      connected.value = false
    })
    pending.value = false
  }
}
async function change(engine: string, voice?: string) {
  await action(async () => {
    await client.request('speech/config', { engine, voice, revision: effective.value?.revision })
    notice.value = t('speechSaved')
  })
}
async function preview() {
  await action(async () => {
    const result = v.parse(v.object({ stage: v.string() }), await client.request('speech/preview', { revision: effective.value?.revision }))
    notice.value = t('speechPreviewStage', { stage: result.stage === 'desktop' ? t('desktop') : t('web') })
  })
}
watch([() => status.connected.value, () => status.state.value?.configuration.speechRevision, () => status.state.value?.busy, () => status.state.value?.hostSpeaking], () => {
  if (status.connected.value)
    void update()
  else
    connected.value = false
}, { immediate: true })
onUnmounted(() => {
  disposed = true
  client.dispose()
})
</script>

<template>
  <section data-cohost-speech :class="['flex flex-col gap-4']">
    <h2>{{ t('speechEngine') }}</h2>
    <p>{{ t('speechUnified') }}</p>
    <FieldInput v-if="needsToken" v-model="token" type="password" :label="t('token')" />
    <p v-if="!connected" role="status">
      {{ t('offline') }}
    </p>
    <template v-if="effective && providers && voices">
      <p data-effective-speech>
        {{ t('speechEffective') }}: {{ effective.model }} · {{ effective.voice }}
      </p>
      <p data-speech-persistence>
        {{ configuration?.persistence.storage === 'sqlite' ? t('speechStored') : t('speechTemporary') }}
      </p>
      <p>{{ t('speechApply') }}</p>
      <FieldSelect :label="t('speechEngine')" :model-value="effective.engine" :options="providers" :disabled="pending || !connected || configuration?.busy" @update:model-value="value => value && change(value)" />
      <FieldSelect v-if="voices.length > 1" :label="t('speechVoice')" :model-value="effective.voice" :options="voices" :disabled="pending || !connected || configuration?.busy" @update:model-value="value => value && change(effective!.engine, value)" />
      <p v-if="effective.capabilities.reference">
        {{ t('speechReference') }}
      </p>
      <p v-if="!effective.capabilities.emotion">
        {{ t('speechNoEmotion') }}
      </p>
      <div :class="['flex flex-wrap gap-2']">
        <Button :disabled="pending || !connected || configuration?.busy" @click="preview">
          {{ t('speechPreview') }}
        </Button>
        <Button v-if="configuration?.preview" @click="action(() => client.request('interrupt', {}))">
          {{ t('interrupt') }}
        </Button>
      </div>
    </template>
    <p v-if="pending" role="status">
      {{ t('speechPreparing') }}
    </p>
    <p v-if="notice" role="status">
      {{ notice }}
    </p>
    <p v-if="error" role="alert">
      {{ error }}
    </p>
  </section>
</template>
