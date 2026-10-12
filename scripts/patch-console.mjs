import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

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
install('packages/stage-ui/src/components/scenarios/cohost-panel.vue',readFileSync(join(root,'integrations/airi/cohost-panel.vue')))
install('packages/stage-ui/src/components/scenarios/cohost-panel.ts',Buffer.from("export { default } from './cohost-panel.vue'\n"))
for(const name of ['en','zh-Hans','decisions'])install('packages/i18n/src/locales/cohost/'+name+'.json',readFileSync(join(root,'integrations/airi/locales',name+'.json')))
function hook(relative, anchor, replacement) {
  const path=join(vendor,relative)
  const source=readFileSync(path,'utf8').replaceAll('\r\n','\n')
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
hook(web,"import Header from", "import CohostPanel from '@proj-airi/stage-ui/components/scenarios/cohost-panel'\nimport { useCohostPerformance } from '../cohost/use-cohost-performance'\n\nimport Header from")
hook(web,'const paused = ref(false)',`const cohostMode = new URLSearchParams(location.search).has('cohost')
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
hook(web,"const cohostMode = new URLSearchParams(location.search).has('cohost')", "const cohostEmbedded = new URLSearchParams(location.search).has('cohostOrigin')\nconst cohostMode = new URLSearchParams(location.search).has('cohost')")
// Keep the model-ready ref before the performance callback on fresh and existing overlays.
const webPath=join(vendor,web)
let webSource=readFileSync(webPath,'utf8').replaceAll('\r\n','\n')
const modelDeclaration="const modelRenderState = ref<'pending' | 'loading' | 'mounted'>('pending')"
webSource=webSource.replaceAll(modelDeclaration+'\n','').replace('const cohostOpen = ref(true)','const cohostOpen = ref(true)\n'+modelDeclaration)
if (readFileSync(webPath,'utf8') !== webSource) {
  writeFileSync(webPath,webSource)
  changed.add(web)
}
replaceHook(web,['!cohostMode && isEnabled && currentStream','isEnabled && currentStream'],'!cohostMode && !cohostEmbedded && isEnabled && currentStream')
hook(web,'<div relative flex-1 min-w="1/2">','<div :class="[\'relative flex-1 min-w-0\']" :style="cohostMode && cohostOpen ? { marginRight: \'min(424px, 55vw)\' } : undefined">')
replaceHook(web,['v-if="!cohostMode && !isMobile"','v-if="!isMobile"'],'v-if="!cohostMode && !cohostEmbedded && !isMobile"')
replaceHook(web,['v-if="!cohostMode && isMobile"','v-if="isMobile"'],'v-if="!cohostMode && !cohostEmbedded && isMobile"')
hook(web,'      <HoloCoupon />','      <CohostPanel v-if="cohostMode" v-model:open="cohostOpen" stage="web" @performance="receiveCohostPerformance?.($event)" />\n      <HoloCoupon />')
const desktop='apps/stage-tamagotchi/src/renderer/pages/index.vue'
hook(desktop,"import AuthStatusIsland from", "import CohostPanel from '@proj-airi/stage-ui/components/scenarios/cohost-panel'\nimport AuthStatusIsland from")
hook(desktop,'const hearingStatusElement = ref<HTMLElement>()',"const cohostMode = location.port === '5174'\nconst cohostOpen = ref(true)\nconst hearingStatusElement = ref<HTMLElement>()")
hook(desktop,'  if (stagePaused.value) {','  if (cohostMode || stagePaused.value) {')
hook(desktop,'  const audioEnabled = enabled.value','  const audioEnabled = !cohostMode && enabled.value')
hook(desktop,"watch(enabled, async (val) => {", "watch(enabled, async (val) => {\n  if (cohostMode) {\n    if (val)\n      enabled.value = false\n    return\n  }")
hook(desktop,'    <!-- Stage is always in DOM', '    <CohostPanel v-if="cohostMode" v-model:open="cohostOpen" stage="desktop" />\n    <!-- Stage is always in DOM')
hook(desktop,'function isVoiceInputSuppressed(now = Date.now()) {','function isVoiceInputSuppressed(now = Date.now()) {\n  if (cohostMode)\n    return true')
hook(desktop,"    <!-- Stage is always in DOM so TresCanvas can measure dimensions -->\n    <div", "    <!-- Stage is always in DOM so TresCanvas can measure dimensions -->\n    <div :style=\"cohostMode && cohostOpen ? { width: 'calc(100% - 424px)' } : undefined\"")
const controls='apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/index.vue'
hook(controls,'const expanded = ref(false)',"const cohostMode = location.port === '5174'\nconst expanded = ref(false)")
hook(controls,'<ControlsIslandChatButton :button-style','<ControlsIslandChatButton v-if="!cohostMode" :button-style')
hook(controls,'<ControlButtonTooltip side="inward">\n            <ControlsIslandHearingConfig','<ControlButtonTooltip v-if="!cohostMode" side="inward">\n            <ControlsIslandHearingConfig')
// Native pages keep their upstream formatting. Only files changed by these hooks are formatted.
if (changed.size) {
  const require=createRequire(join(vendor,'package.json'))
  const eslint=join(dirname(require.resolve('eslint/package.json')),'bin/eslint.js')
  const formatted=spawnSync(process.execPath,[eslint,'--fix',...changed],{cwd:vendor,stdio:'inherit'})
  if(formatted.status!==0)throw Error('Native console page formatting failed')
}
console.log('Applied the shared AIRI live room panel.')
