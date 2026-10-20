import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
const root=fileURLToPath(new URL('../',import.meta.url)),vendor=join(root,'vendor/airi')
function install(target,source) {
  const path=join(vendor,target),saved=join(root,'data/airi-settings-overlay',target),bytes=readFileSync(join(root,source))
  if(existsSync(path)&&!readFileSync(path).equals(bytes)&&(!existsSync(saved)||!readFileSync(path).equals(readFileSync(saved))))throw Error('Unsaved settings overlay: '+target)
  mkdirSync(dirname(path),{recursive:true});mkdirSync(dirname(saved),{recursive:true});writeFileSync(path,bytes);writeFileSync(saved,bytes)
}
for(const name of ['cohost-services-settings.vue','cohost-catalog.ts','cohost-catalog.test.ts','cohost-catalog.browser.test.ts'])install('packages/stage-ui/src/components/scenarios/'+name,'integrations/airi/'+name)
for(const module of ['hearing','consciousness']) {
  const page=`packages/stage-pages/src/pages/settings/modules/${module}.vue`
  const original=spawnSync('git',['show','HEAD:'+page],{cwd:vendor,encoding:'utf8'})
  if(original.status!==0)throw Error('Cannot read pinned settings page')
  const native=join(vendor,'packages/stage-pages/src/components',`native-${module}-settings.vue`)
  writeFileSync(native,original.stdout.replace(/<route lang="yaml">[\s\S]*?<\/route>/,'').replaceAll("from './components/","from '../pages/settings/modules/components/").trimEnd()+'\n')
  const source=`<script setup lang="ts">
import CohostServicesSettings from '@proj-airi/stage-ui/components/scenarios/cohost-services-settings'
import { isCohostMode } from '@proj-airi/stage-ui/composables/cohost-media-state'
import { defineAsyncComponent } from 'vue'
const cohostMode = isCohostMode()
const NativeSettings = defineAsyncComponent(() => import('../../../components/native-${module}-settings.vue'))
</script>
<template>
  <CohostServicesSettings v-if="cohostMode" module="${module==='hearing'?'recognition':'inference'}" />
  <NativeSettings v-else />
</template>
<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.${module}.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
`
  writeFileSync(join(vendor,page),source)
}
writeFileSync(join(vendor,'packages/stage-ui/src/components/scenarios/cohost-services-settings.ts'),"export { default } from './cohost-services-settings.vue'\n")
const path=join(vendor,'packages/stage-ui/src/stores/modules/airi-card.ts')
let source=readFileSync(path,'utf8').replaceAll('\r\n','\n')
if(!source.includes('async function applyCohostCatalog(')) {
  source="import type { CatalogValue } from '../../components/scenarios/cohost-catalog'\n"+source
  source=source.replace("import { computed, toRaw } from 'vue'","import { computed, ref, toRaw } from 'vue'")
  source=source.replace('  let initialized = false',`  const cohostRepositoryError = ref('')
  const cohostReloadVersion = ref(0)
  async function setCohostRepositoryError(value: string) {
    cohostRepositoryError.value = value
  }
  async function reloadCohostRepository() {
    cohostReloadVersion.value++
  }
  let initialized = false`)
  source=source.replace('  function resetState() {',`  /** Apply a committed repository snapshot in the leader. Remote replicas never write the repository. */
  async function applyCohostCatalog(next: CatalogValue) {
    const incoming = new Map(next.cards.map(entry => [entry.id, newAiriCard(entry.data)]))
    if (activeCardId.value === next.activeId && JSON.stringify(Array.from(cards.value)) === JSON.stringify(Array.from(incoming)))
      return
    cards.value = incoming
    activeCardId.value = next.activeId
    await applyActiveCardSettings()
  }

  function resetState() {`)
  source=source.replace('    resetState,','    resetState,\n    applyCohostCatalog,\n    cohostRepositoryError,\n    cohostReloadVersion,\n    setCohostRepositoryError,\n    reloadCohostRepository,').replace("      'activateCard',","      'applyCohostCatalog',\n      'setCohostRepositoryError',\n      'reloadCohostRepository',\n      'activateCard',")
}
if(!source.includes('Repository model IDs refer to device-local assets.')) {
  source=source.replace("import { useProviderConfigStore }", "import { useDisplayModelsStore } from '../display-models'\nimport { useProviderConfigStore }")
  source=source.replace('    if (modules.displayModelId !== undefined)\n      stageModel.stageModelSelected = modules.displayModelId', `    // Repository model IDs refer to device-local assets. Keep this device's model
    // when another renderer's card refers to an asset that is not installed here.
    const localCatalog = typeof localStorage !== 'undefined' && localStorage.getItem('cohost/enabled') === 'true'
    if (modules.displayModelId !== undefined && (!localCatalog || !modules.displayModelId || await useDisplayModelsStore().getDisplayModel(modules.displayModelId)))
      stageModel.stageModelSelected = modules.displayModelId`)
}
writeFileSync(path,source)
const editorPath=join(vendor,'packages/stage-pages/src/pages/settings/airi-card/components/CardEditor.vue')
let editor=readFileSync(editorPath,'utf8').replaceAll('\r\n','\n')
if(!editor.includes('const cohostMode = isCohostMode()')) {
  editor=editor.replace('<script setup lang="ts">',`<script setup lang="ts">
import { isCohostMode } from '@proj-airi/stage-ui/composables/cohost-media-state'
import { RouterLink } from 'vue-router'
import cohostEn from '../../../../../../i18n/src/locales/cohost/en.json'
import cohostZh from '../../../../../../i18n/src/locales/cohost/zh-Hans.json'`)
  editor=editor.replace('const { t } = useI18n()',`const { t } = useI18n()
const { t: cohostText } = useI18n({ useScope: 'local', messages: { en: cohostEn, 'zh-Hans': cohostZh }, fallbackLocale: 'zh-Hans' })
const cohostMode = isCohostMode()`)
  for(const section of ['Chat','Vision','Speech'])editor=editor.replace(`<!-- ${section} -->\n              <section :class="moduleSectionClasses">`,`<!-- ${section} -->\n              <section v-if="!cohostMode" :class="moduleSectionClasses">`)
  editor=editor.replace('              <!-- Chat -->',`              <div v-if="cohostMode" :class="['flex flex-col gap-3']">
                <p>{{ cohostText('cardServiceScope') }}</p>
                <RouterLink to="/settings/modules/consciousness">{{ cohostText('inferenceOpen') }}</RouterLink>
                <RouterLink to="/settings/modules/speech">{{ cohostText('speechOpen') }}</RouterLink>
              </div>
              <!-- Chat -->`)
}
editor=editor.replaceAll('@proj-airi/i18n/locales/cohost/','../../../../../../i18n/src/locales/cohost/')
writeFileSync(editorPath,editor)
const require=createRequire(join(vendor,'package.json')),eslint=join(dirname(require.resolve('eslint/package.json')),'bin/eslint.js')
const result=spawnSync(process.execPath,[eslint,'--fix',path,editorPath,...['hearing','consciousness'].map(module=>join(vendor,`packages/stage-pages/src/pages/settings/modules/${module}.vue`))],{cwd:vendor,stdio:'inherit'})
if(result.status!==0)throw Error('Settings integration formatting failed')
console.log('Applied unified service pages and character repository adapter.')
