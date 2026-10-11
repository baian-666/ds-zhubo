import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url))
const base=JSON.parse(readFileSync(join(root,'airi.lock.json'),'utf8'))
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:join(root,'vendor/airi'),encoding:'utf8'})
if(head.status!==0 || head.stdout.trim()!==base.commit)throw Error('AIRI voice overlay requires the pinned base')
const dest=join(root,'vendor/airi/packages/stage-ui/src/composables/use-cohost-voice.ts')
const src=readFileSync(join(root,'integrations/airi/use-cohost-voice.ts'))
const saved=join(root,'data/airi-overlay/shared-voice.ts')
if(existsSync(dest)&&!readFileSync(dest).equals(src)&&(!existsSync(saved)||!readFileSync(dest).equals(readFileSync(saved))))throw Error('Unsaved shared voice edits')
mkdirSync(dirname(dest),{recursive:true});mkdirSync(dirname(saved),{recursive:true})
if(!existsSync(dest)||!readFileSync(dest).equals(src))writeFileSync(dest,src)
writeFileSync(saved,src)
const stage=join(root,'vendor/airi/packages/stage-ui/src/components/scenes/Stage.vue')
let s=readFileSync(stage,'utf8')
const imports="import { useCohostVoice } from '../../composables/use-cohost-voice'"
if(!s.includes(imports)){
if(!s.includes("import { useDuckDb }") || !s.includes('const { audioContext } = useAudioContext()') || !s.includes('  tts: async (request, signal) => {') || !s.includes('void speechRuntimeStore.registerHost(speechPipeline)'))throw Error('Shared Stage anchors changed')
s=s.replace("import { useDuckDb }",imports+"\nimport { useDuckDb }")
s=s.replace("const { audioContext } = useAudioContext()","const { audioContext } = useAudioContext()\nconst cohostVoice = useCohostVoice(audioContext, () => componentState.value === 'mounted' && !props.paused)")
s=s.replace("  tts: async (request, signal) => {","  tts: async (request, signal) => {\n    if (request.turnId?.startsWith('cohost:'))\n      return await cohostVoice.synthesize(request, signal)\n")
s=s.replace("void speechRuntimeStore.registerHost(speechPipeline)","void speechRuntimeStore.registerHost(speechPipeline)\ncohostVoice.bind(speechPipeline)")
writeFileSync(stage,s)
}
let playSource=readFileSync(stage,'utf8')
playSource=playSource.replace('useCohostVoice(audioContext, () => !props.paused)', "useCohostVoice(audioContext, () => componentState.value === 'mounted' && !props.paused)")
const playAnchor='  const source = audioContext.createBufferSource()'
const playGuard="  if (item.turnId?.startsWith('cohost:') && !await cohostVoice.beforePlay(item.turnId, signal))\n    throw new Error('Cohost playback cancelled')\n\n"+playAnchor
if(!playSource.includes(playGuard)){
  if(!playSource.includes(playAnchor))throw Error('Stage playback anchor changed')
  writeFileSync(stage,playSource.replace(playAnchor,playGuard))
}
if(readFileSync(stage,'utf8')!==playSource && playSource.includes(playGuard))writeFileSync(stage,playSource)
console.log('Applied shared AIRI voice overlay.')
