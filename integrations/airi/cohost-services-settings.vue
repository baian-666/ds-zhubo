<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput, FieldSelect } from '@proj-airi/ui'
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import * as v from 'valibot'

import en from '../../../../i18n/src/locales/cohost/en.json'
import zh from '../../../../i18n/src/locales/cohost/zh-Hans.json'

import { cohostAccessToken, cohostNeedsToken } from '../../composables/cohost-media-state'
import { useSettingsAudioDevice } from '../../stores/settings/audio-device'
import { CohostClient } from './cohost-client'
import { useCohostStatus } from './use-cohost-status'

const props = defineProps<{ module: 'inference' | 'recognition' }>()
const { t } = useI18n({ useScope: 'local', messages: { en, 'zh-Hans': zh }, fallbackLocale: 'zh-Hans' })
const section = v.object({ revision: v.string(), value: v.object({ provider: v.string(), model: v.string() }) })
const schema = v.object({ inference: section, recognition: section, persistence: v.object({ storage: v.picklist(['sqlite', 'memory']) }), configured: v.object({ inference: v.boolean(), recognition: v.boolean() }) })
const configuration = shallowRef<v.InferOutput<typeof schema>>()
const { state, connected } = useCohostStatus()
const audioSettings = useSettingsAudioDevice()
const model = ref('')
const recognitionChoice = ref('siliconflow')
const recognitionOptions = computed(() => [
  { label: t('recognitionStreaming'), value: 'dashscope', model: 'fun-asr-realtime' },
  { label: t('recognitionLocal'), value: 'local', model: 'sherpa-zipformer-zh' },
  { label: t('recognitionBatch'), value: 'siliconflow', model: 'FunAudioLLM/SenseVoiceSmall' },
])
const draftRevision = ref('')
const pending = ref(false)
const error = ref('')
const notice = ref('')
const client = new CohostClient(() => cohostAccessToken.value, () => t('requestTimeout'), () => {
  cohostNeedsToken.value = true
})
const effective = computed(() => configuration.value?.[props.module])
const busy = computed(() => !connected.value || pending.value || state.value?.busy || state.value?.hostSpeaking || state.value?.participation?.busy)
const microphones = computed(() => [{ label: t('systemMicrophone'), value: 'default' }, ...audioSettings.audioInputOptions.filter(input => input.value !== 'default')])
let generation = 0
async function refresh(replaceDraft = false) {
  const current = ++generation
  try {
    const next = v.parse(schema, await client.request('services/config'))
    if (current !== generation)
      return
    configuration.value = next
    if (!draftRevision.value || replaceDraft) {
      model.value = next[props.module].value.model
      recognitionChoice.value = next.recognition.value.provider
      draftRevision.value = next[props.module].revision
    }
  }
  catch (cause) { error.value = errorMessageFrom(cause) ?? t('offline') }
}
async function save() {
  if (pending.value || !effective.value)
    return
  pending.value = true
  error.value = ''
  notice.value = ''
  try {
    let value = { provider: effective.value.value.provider, model: model.value.trim() }
    if (props.module === 'recognition') {
      const selected = recognitionOptions.value.find(option => option.value === recognitionChoice.value)
      if (!selected)
        throw new Error(t('serviceConflict'))
      value = { provider: selected.value, model: selected.model }
    }
    await client.request('services/config', { module: props.module, revision: draftRevision.value, value })
    await refresh(true)
    notice.value = t('serviceSaved')
  }
  catch (cause) { error.value = errorMessageFrom(cause) ?? t('offline') }
  finally { pending.value = false }
}
watch([connected, () => state.value?.configuration.inferenceRevision, () => state.value?.configuration.recognitionRevision], () => {
  if (connected.value && !pending.value)
    void refresh()
}, { immediate: true })
onUnmounted(() => {
  generation++
  client.dispose()
})
</script>

<template>
  <section data-cohost-services :class="['flex flex-col gap-4']">
    <h2>{{ t(module === 'inference' ? 'inferenceTitle' : 'recognitionTitle') }}</h2>
    <p>{{ t('servicesUnified') }}</p>
    <FieldInput v-if="cohostNeedsToken" v-model="cohostAccessToken" type="password" :label="t('token')" />
    <p v-if="!connected" role="status">
      {{ t('offline') }}
    </p>
    <template v-if="effective">
      <p data-effective-service>
        {{ t('serviceEffective') }}: {{ effective.value.provider }} · {{ effective.value.model }}
      </p>
      <p>{{ configuration?.persistence.storage === 'sqlite' ? t('serviceStored') : t('speechTemporary') }}</p>
      <p v-if="module === 'recognition' && effective.value.provider === 'local'">{{ t(configuration?.configured.recognition ? 'localRecognitionReady' : 'localRecognitionMissing') }}</p>
      <p v-else>{{ t(configuration?.configured[module] ? 'serviceKeyReady' : 'serviceKeyMissing') }}</p>
      <template v-if="module === 'inference'">
        <FieldInput v-model="model" :label="t('model')" :disabled="pending" />
        <p>{{ t('inferenceApply') }}</p>
      </template>
      <template v-else>
        <FieldSelect v-model="recognitionChoice" :label="t('recognitionService')" :options="recognitionOptions" :disabled="pending" />
        <FieldSelect v-model="audioSettings.selectedAudioInput" :label="t('nativeMicrophone')" :options="microphones" />
        <Button v-if="!audioSettings.permissionGranted" @click="audioSettings.askPermission().catch(cause => error = errorMessageFrom(cause) ?? t('offline'))">
          {{ t('microphonePermission') }}
        </Button>
        <p>{{ t('recognitionApply') }}</p>
        <p>{{ t('recognitionTest') }}</p>
      </template>
      <p v-if="draftRevision !== effective.revision" role="status">
        {{ t('serviceConflict') }}
      </p>
      <div :class="['flex flex-wrap gap-2']">
        <Button :disabled="busy || (module === 'recognition' && state?.airi.capture)" @click="save">
          {{ t('serviceSave') }}
        </Button>
        <Button :disabled="pending" @click="refresh(true)">
          {{ t('serviceReload') }}
        </Button>
      </div>
    </template>
    <p v-if="pending" role="status">
      {{ t('serviceValidating') }}
    </p>
    <p v-if="notice" role="status">
      {{ notice }}
    </p>
    <p v-if="error" role="alert">
      {{ error }}
    </p>
  </section>
</template>
