<script setup lang="ts">
import CohostSpeechSettings from '@proj-airi/stage-ui/components/scenarios/cohost-speech-settings'

import { isCohostMode } from '@proj-airi/stage-ui/composables/cohost-media-state'
import { defineAsyncComponent } from 'vue'

const cohostMode = isCohostMode()
const NativeSpeechSettings = defineAsyncComponent(() => import('../../../components/native-speech-settings.vue'))
</script>

<template>
  <CohostSpeechSettings v-if="cohostMode" />
  <NativeSpeechSettings v-else />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.speech.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
