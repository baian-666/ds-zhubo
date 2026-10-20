<script setup lang="ts">
import CohostSettings from '@proj-airi/stage-ui/components/scenarios/cohost-settings'
</script>

<template>
  <CohostSettings />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: cohost.liveSettings
  subtitleKey: settings.title
  icon: i-solar:microphone-3-bold-duotone
  settingsEntry: true
  order: 1
</route>
