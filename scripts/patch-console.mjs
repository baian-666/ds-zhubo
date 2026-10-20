import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { performanceContracts, performanceSource } from './performance-overlay.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const vendor=join(root,'vendor/airi')
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:vendor,encoding:'utf8'})
if(head.stdout.trim()!==JSON.parse(readFileSync(join(root,'airi.lock.json'))).commit)throw Error('Unexpected AIRI revision')
function install(relative, contents) {
  const path=join(vendor,relative), saved=join(root,'data/airi-console-overlay',relative)
  if(existsSync(path)&&!readFileSync(path).equals(contents)&&(!existsSync(saved)||!readFileSync(path).equals(readFileSync(saved))))throw Error('Unsaved console overlay: '+relative)
  mkdirSync(dirname(path),{recursive:true});mkdirSync(dirname(saved),{recursive:true})
  if(!existsSync(path)||!readFileSync(path).equals(contents))writeFileSync(path,contents)
  writeFileSync(saved,contents)
}
const changed = new Set()
for(const name of [...performanceContracts,'whale-capabilities.ts'])
  install('packages/stage-ui/src/components/scenarios/'+name,Buffer.from(performanceSource(name).toString().replaceAll("from './whale-rig'","from './cohost-whale-rig'")))
install('packages/stage-ui/src/components/scenarios/cohost-whale-rig.ts',readFileSync(join(root,'integrations/airi/whale-rig.ts')))
install('packages/stage-ui/src/components/scenarios/cohost-status-contract.ts',readFileSync(join(root,'packages/cohost-contracts/status.ts')))
install('packages/stage-ui/src/components/scenarios/cohost-director-contract.ts',readFileSync(join(root,'packages/cohost-contracts/director.ts')))
install('packages/stage-ui/src/components/scenarios/cohost-director-settings.vue',readFileSync(join(root,'integrations/airi/cohost-director-settings.vue')))
install('packages/stage-ui/src/components/scenarios/cohost-director-settings.browser.test.ts',readFileSync(join(root,'integrations/airi/cohost-director-settings.browser.test.ts')))
for (const name of ['cohost-client.ts','cohost-status.ts','cohost-status-connection.ts','cohost-status-connection.test.ts','use-cohost-status.ts','cohost-settings.vue'])
  install('packages/stage-ui/src/components/scenarios/'+name,readFileSync(join(root,'integrations/airi',name)))
install('packages/stage-ui/src/components/scenarios/cohost-settings.ts',Buffer.from("export { default } from './cohost-settings.vue'\n"))
install('packages/stage-pages/src/pages/settings/modules/cohost.vue',readFileSync(join(root,'integrations/airi/cohost-settings-page.vue')))
install('packages/stage-ui/src/components/scenarios/cohost-panel.vue',readFileSync(join(root,'integrations/airi/cohost-panel.vue')))
install('packages/stage-ui/src/components/scenarios/cohost-panel.ts',Buffer.from("export { default } from './cohost-panel.vue'\n"))
for(const name of ['en','zh-Hans','decisions'])install('packages/i18n/src/locales/cohost/'+name+'.json',readFileSync(join(root,'integrations/airi/locales',name+'.json')))
function hook(relative, anchor, replacement) {
  const path=join(vendor,relative)
  const source=readFileSync(path,'utf8').replaceAll('\r\n','\n')
  const variable = replacement.match(/^const (\w+) =/)
  if (variable && source.includes('const '+variable[1]+' =')) return
  const declaration = replacement.match(/^function (\w+)\(/)
  if (declaration && source.includes('function '+declaration[1]+'(')) return
  const importLine = replacement.split('\n').find(line => line.startsWith('import '))
  if (anchor.startsWith('<script') && importLine && source.includes(importLine)) return
  if(source.includes(replacement))return
  if(source.replace(/\s+/g,'').includes(replacement.replace(/\s+/g,'')))return
  if(anchor.startsWith('import ') && source.includes(replacement.split('\n')[0]))return
  if(anchor.startsWith('const ') && source.includes(replacement.split('\n')[0]))return
  if(!source.includes(anchor))throw Error('Console anchor changed: '+relative)
  writeFileSync(path,source.replace(anchor,replacement))
  changed.add(relative)
}
function replaceHook(relative, anchors, replacement) {
  const source=readFileSync(join(vendor,relative),'utf8').replaceAll('\r\n','\n')
  if(source.replace(/\s+/g,'').includes(replacement.replace(/\s+/g,'')))return
  const anchor=anchors.find(value=>source.includes(value))
  if(!anchor)throw Error('Console anchor changed: '+relative)
  hook(relative,anchor,replacement)
}
const web='apps/stage-web/src/pages/index.vue'
for (const locale of ['en','zh-Hans']) {
  hook(`packages/i18n/src/locales/${locale}/index.ts`, "import base from './base.yaml'", "import cohost from '../cohost/"+locale+".json'\nimport base from './base.yaml'")
  hook(`packages/i18n/src/locales/${locale}/index.ts`, 'export default {', 'export default {\n  cohost,')
}
hook(web,"import Header from", "import CohostPanel from '@proj-airi/stage-ui/components/scenarios/cohost-panel'\nimport { useCohostPerformance } from '../cohost/use-cohost-performance'\n\nimport Header from")
hook(web,'const paused = ref(false)',`const cohostMode = isCohostMode()
const cohostOpen = ref(true)
const modelRenderState = ref<'pending' | 'loading' | 'mounted'>('pending')
let receiveCohostPerformance: ((value: unknown) => void) | undefined
if (cohostMode) {
  useCohostPerformance((receive) => {
    receiveCohostPerformance = receive
    return {
      emit: () => {},
      dispose: () => {
        receiveCohostPerformance = undefined
      },
    }
  }, () => modelRenderState.value === 'mounted')
}
const paused = ref(false)`)
hook(web,"const cohostMode = isCohostMode()", "const cohostEmbedded = new URLSearchParams(location.search).has('cohostOrigin')\nconst cohostMode = isCohostMode()")
// Keep the model-ready ref before the performance callback on fresh and existing overlays.
const webPath=join(vendor,web)
let webSource=readFileSync(webPath,'utf8').replaceAll('\r\n','\n')
const modelDeclaration="const modelRenderState = ref<'pending' | 'loading' | 'mounted'>('pending')"
webSource=webSource.replaceAll(modelDeclaration+'\n','').replace('const cohostOpen = ref(true)','const cohostOpen = ref(true)\n'+modelDeclaration)
// Embedded stages receive commands from their parent. Do not claim the same pose owner twice.
webSource=webSource.replace('if (cohostMode) {\n  useCohostPerformance(', 'if (cohostMode && !cohostEmbedded) {\n  useCohostPerformance(')
if (readFileSync(webPath,'utf8') !== webSource) {
  writeFileSync(webPath,webSource)
  changed.add(web)
}
replaceHook(web,['!cohostMode && isEnabled && currentStream','isEnabled && currentStream'],'!cohostMode && !cohostEmbedded && isEnabled && currentStream')
if (!readFileSync(join(vendor,web),'utf8').includes('cohostMode && !cohostEmbedded && cohostOpen ? { marginRight:'))
  hook(web,'<div relative flex-1 min-w="1/2">','<div :class="[\'relative flex-1 min-w-0\']" :style="cohostMode && cohostOpen ? { marginRight: \'min(424px, 55vw)\' } : undefined">')
replaceHook(web,['v-if="!cohostMode && !isMobile"','v-if="!isMobile"'],'v-if="!cohostMode && !cohostEmbedded && !isMobile"')
replaceHook(web,['v-if="!cohostMode && isMobile"','v-if="isMobile"'],'v-if="!cohostMode && !cohostEmbedded && isMobile"')
if (!readFileSync(join(vendor,web),'utf8').includes('<CohostPanel'))
  hook(web,'      <HoloCoupon />','      <CohostPanel v-if="cohostMode" v-model:open="cohostOpen" stage="web" @performance="receiveCohostPerformance?.($event)" />\n      <HoloCoupon />')
const desktop='apps/stage-tamagotchi/src/renderer/pages/index.vue'
hook(desktop,"import AuthStatusIsland from", "import CohostPanel from '@proj-airi/stage-ui/components/scenarios/cohost-panel'\nimport AuthStatusIsland from")
hook(desktop,'const hearingStatusElement = ref<HTMLElement>()',"const cohostMode = isCohostMode()\nconst cohostOpen = ref(true)\nconst hearingStatusElement = ref<HTMLElement>()")
hook(desktop,'  if (stagePaused.value) {','  if (cohostMode || stagePaused.value) {')
hook(desktop,'  const audioEnabled = enabled.value','  const audioEnabled = !cohostMode && enabled.value')
hook(desktop,"watch(enabled, async (val) => {", "watch(enabled, async (val) => {\n  if (cohostMode) {\n    if (val)\n      enabled.value = false\n    return\n  }")
if (!readFileSync(join(vendor,desktop),'utf8').includes('<CohostPanel'))
  hook(desktop,'    <!-- Stage is always in DOM', '    <CohostPanel v-if="cohostMode" v-model:open="cohostOpen" stage="desktop" />\n    <!-- Stage is always in DOM')
hook(desktop,'function isVoiceInputSuppressed(now = Date.now()) {','function isVoiceInputSuppressed(now = Date.now()) {\n  if (cohostMode)\n    return true')
if (!readFileSync(join(vendor,desktop),'utf8').includes('cohostMode && cohostOpen ? { width:'))
  hook(desktop,"    <!-- Stage is always in DOM so TresCanvas can measure dimensions -->\n    <div", "    <!-- Stage is always in DOM so TresCanvas can measure dimensions -->\n    <div :style=\"cohostMode && cohostOpen ? { width: 'calc(100% - 424px)' } : undefined\"")
replaceHook(web, ['min(424px, 55vw)'], 'min(504px, 100vw)')
replaceHook(desktop, ['calc(100% - 424px)'], 'max(0px, calc(100% - 504px))')
const controls='apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/index.vue'
hook(controls,'const expanded = ref(false)',"const cohostMode = isCohostMode()\nconst expanded = ref(false)")
hook(controls,'<ControlsIslandChatButton :button-style','<ControlsIslandChatButton v-if="!cohostMode" :button-style')
hook(controls,'<ControlButtonTooltip side="inward">\n            <ControlsIslandHearingConfig','<ControlButtonTooltip v-if="!cohostMode" side="inward">\n            <ControlsIslandHearingConfig')
for (const page of [web, desktop]) {
  const path=join(vendor,page)
  let text=readFileSync(path,'utf8')
  text=text.replace("function openCohostSettings() { void cohostRouter.push('/settings/modules/cohost') }", "function openCohostSettings() {\n  location.assign('/settings/modules/cohost')\n}")
  text=text.replace("location.assign('/settings/modules/cohost')", "void cohostRouter.push('/settings/modules/cohost')")
  text=text.replace(/( @settings="[^"]+")\1/g,'$1')
  if (text!==readFileSync(path,'utf8')) { writeFileSync(path,text);changed.add(page) }
}
if (!readFileSync(join(vendor,web),'utf8').includes('@settings="openCohostSettings"'))
  hook(web,'<CohostPanel v-if="cohostMode"', '<CohostPanel @settings="openCohostSettings" v-if="cohostMode"')
replaceHook(web,['v-if="cohostMode" v-model:open="cohostOpen" stage="web"'],'v-if="cohostMode && !cohostEmbedded" v-model:open="cohostOpen" stage="web"')
replaceHook(web,['cohostMode && cohostOpen ? { marginRight:'],'cohostMode && !cohostEmbedded && cohostOpen ? { marginRight:')
hook(web,'const cohostOpen = ref(true)', "function openCohostSettings() {\n  location.assign('/settings/modules/cohost')\n}\nconst cohostOpen = ref(true)")
if (!readFileSync(join(vendor,desktop),'utf8').includes('electronOpenSettings'))
  hook(desktop,"import CohostPanel from", "import { electronOpenSettings } from '../../shared/eventa'\nimport CohostPanel from")
hook(desktop,'const cohostOpen = ref(true)', "const openCohostSettings = useElectronEventaInvoke(electronOpenSettings)\nconst cohostOpen = ref(true)")
if (!readFileSync(join(vendor,desktop),'utf8').includes('@settings="openCohostSettings'))
  hook(desktop,'<CohostPanel v-if="cohostMode"', '<CohostPanel @settings="openCohostSettings({ route: \'/settings/modules/cohost\' })" v-if="cohostMode"')
for (const page of [web, desktop, controls]) {
  hook(page, '<script setup lang="ts">', `<script setup lang="ts">\nimport { isCohostMode } from '@proj-airi/stage-ui/composables/cohost-media-state'`)
  const path=join(vendor,page)
  const current=readFileSync(path,'utf8')
  writeFileSync(path,current.replace("const cohostMode = location.port === '5174'",'const cohostMode = isCohostMode()').replace("const cohostMode = new URLSearchParams(location.search).has('cohost')",'const cohostMode = isCohostMode()'))
}
hook(web, '<script setup lang="ts">', `<script setup lang="ts">\nimport { useRouter } from 'vue-router'`)
hook(web, 'const cohostMode = isCohostMode()', 'const cohostRouter = useRouter()\nconst cohostMode = isCohostMode()')
// Native pages keep their upstream formatting. Only files changed by these hooks are formatted.
if (changed.size) {
  const require=createRequire(join(vendor,'package.json'))
  const eslint=join(dirname(require.resolve('eslint/package.json')),'bin/eslint.js')
  const formatted=spawnSync(process.execPath,[eslint,'--fix',...changed],{cwd:vendor,stdio:'inherit'})
  if(formatted.status!==0)throw Error('Native console page formatting failed')
}
const characterPatch=spawnSync(process.execPath,[join(root,'scripts/patch-character.mjs')],{cwd:root,stdio:'inherit'})
if(characterPatch.status!==0)throw Error('Character overlay failed')
console.log('Applied the shared AIRI live room panel.')
