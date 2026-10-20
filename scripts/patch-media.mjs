import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const vendor = join(root, 'vendor/airi')
const changed = new Set()
function install(path, source) {
  const target = join(vendor, path), saved = join(root, 'data/airi-media-overlay', path)
  const bytes = readFileSync(join(root, source))
  if (existsSync(target) && !readFileSync(target).equals(bytes) && (!existsSync(saved) || !readFileSync(target).equals(readFileSync(saved)))) throw Error('Unsaved media overlay: ' + path)
  mkdirSync(dirname(target), { recursive:true }); mkdirSync(dirname(saved), { recursive:true })
  writeFileSync(target, bytes); writeFileSync(saved, bytes)
}
for (const name of ['performance-clock.ts','cohost-media-state.ts','use-cohost-media-host.ts','use-cohost-character.ts','pausable-audio.ts','pausable-audio.browser.test.ts']) install('packages/stage-ui/src/composables/'+name,'integrations/airi/'+name)
install('packages/stage-ui/src/composables/speech-floor.ts','packages/cohost-contracts/floor.ts')
install('packages/stage-ui/src/composables/listening-tail.ts','packages/cohost-contracts/listening-tail.ts')
install('packages/stage-ui/src/components/scenarios/cohost-speech-settings.vue','integrations/airi/cohost-speech-settings.vue')
install('packages/stage-ui/src/components/scenarios/cohost-speech-contract.ts','packages/cohost-contracts/speech.ts')
writeFileSync(join(vendor,'packages/stage-ui/src/components/scenarios/cohost-speech-settings.ts'),"export { default } from './cohost-speech-settings.vue'\n")
function edit(path, transform) {
  const target = join(vendor,path), before = readFileSync(target,'utf8').replaceAll('\r\n','\n')
  const after = transform(before)
  if (before !== after) { writeFileSync(target,after); changed.add(path) }
}
function add(text, anchor, replacement) {
  if (text.includes(replacement)) return text
  if (replacement.startsWith('import ') && text.includes(replacement.split('\n')[0])) return text
  if (!text.includes(anchor)) throw Error('Media overlay anchor changed: '+anchor)
  return text.replace(anchor,replacement)
}
edit('packages/stage-ui/src/components/scenes/Stage.vue', text => {
  // Migrate the old stage-owned bridge. The application now owns that bridge.
  text = text.replace("import { useCohostVoice } from '../../composables/use-cohost-voice'\n",'')
    .replace(/^const cohostVoice = useCohostVoice\([^\n]+\n/m,'')
    .replace(/^\s*ttsStream: \(request, signal\) => request.turnId\?\.startsWith\('cohost:'\)[^\n]+\n/m,'\n')
    .replace("    if (request.turnId?.startsWith('cohost:'))\n      return await cohostVoice.synthesize(request, signal)\n\n",'')
    .replace("  if (item.turnId?.startsWith('cohost:') && !await cohostVoice.beforePlay(item.turnId, signal))\n    throw new Error('Cohost playback cancelled')\n\n",'')
    .replace('cohostVoice.bind(speechPipeline)\n','')
  text = text.replace("import { cohostAudioBus, cohostPlaying, isCohostMode }", "import { cohostAudioBus, cohostCaption, cohostPlaying, isCohostMode }")
  text = add(text,"import { useDuckDb }", "import { cohostAudioBus, cohostCaption, cohostPlaying, isCohostMode } from '../../composables/cohost-media-state'\nimport { useDuckDb }")
  const hook = `
watch([cohostAudioBus, audioAnalyser, lipSyncNode], ([bus, analyser, lips], _, cleanup) => {
  if (!bus)
    return
  if (analyser)
    bus.connect(analyser)
  if (lips)
    bus.connect(lips)
  cleanup(() => {
    if (analyser)
      bus.disconnect(analyser)
    if (lips)
      bus.disconnect(lips)
  })
}, { immediate: true })
watch(cohostPlaying, (playing) => {
  if (isCohostMode())
    nowSpeaking.value = playing
}, { immediate: true })
`
  if (!text.includes('watch([cohostAudioBus,')) text = add(text,'function setupAnalyser() {',hook+'\nfunction setupAnalyser() {')
  if (!text.includes('watch(cohostCaption,')) text = add(text,'function setupAnalyser() {',`watch(cohostCaption, (caption) => {
  if (isCohostMode())
    assistantCaption.value = caption
}, { immediate: true })

function setupAnalyser() {`)
  if (!text.includes('watch([cohostAudioBus, stageModelRenderer]')) text = add(text,'function setupAnalyser() {',`watch([cohostAudioBus, stageModelRenderer], ([bus]) => {
  if (bus) {
    setupAnalyser()
    void setupLipSync()
  }
}, { immediate: true })

function setupAnalyser() {`)
  return text
})
for (const [path,stage,anchor] of [
  ['apps/stage-web/src/App.vue','web','usePWAStore()'],
  ['apps/stage-tamagotchi/src/renderer/App.vue','desktop','const windowContext = resolveRendererWindowContext()'],
]) edit(path,text => {
  text = add(text,"import { useInferencePreload }", "import { isCohostMode } from '@proj-airi/stage-ui/composables/cohost-media-state'\nimport { useCohostMediaHost } from '@proj-airi/stage-ui/composables/use-cohost-media-host'\nimport { useInferencePreload }")
  const setup = stage === 'web' ? "if (isCohostMode())\n  useCohostMediaHost('web')" : "localStorage.setItem('cohost/enabled', 'true')\nif (isCohostMode() && windowContext.leadership === 'leader-only')\n  useCohostMediaHost('desktop')"
  return text.includes(`useCohostMediaHost('${stage}')`) ? text : add(text,anchor,anchor+'\n'+setup)
})
const speechPage = 'packages/stage-pages/src/pages/settings/modules/speech.vue'
const upstream = spawnSync('git',['show','HEAD:'+speechPage],{cwd:vendor,encoding:'utf8'})
if (upstream.status !== 0) throw Error('Cannot read pinned native speech settings')
const nativePage = join(vendor,'packages/stage-pages/src/components/native-speech-settings.vue')
const nativeSource = upstream.stdout.replace(/<route lang="yaml">[\s\S]*?<\/route>/,'').trimEnd()+'\n'
if (existsSync(nativePage) && readFileSync(nativePage,'utf8').trimEnd() !== nativeSource.trimEnd()) throw Error('Unsaved native speech settings')
mkdirSync(dirname(nativePage),{recursive:true})
writeFileSync(nativePage,nativeSource)
edit(speechPage,()=>readFileSync(join(root,'integrations/airi/cohost-speech-page.vue'),'utf8'))
if (changed.size) {
  const require = createRequire(join(vendor,'package.json'))
  const eslint = join(dirname(require.resolve('eslint/package.json')),'bin/eslint.js')
  const result = spawnSync(process.execPath,[eslint,'--fix',...changed],{cwd:vendor,stdio:'inherit'})
  if (result.status !== 0) throw Error('Media overlay formatting failed')
}
console.log('Applied application-owned cohost media and native speech settings.')
await import('./patch-settings.mjs')
