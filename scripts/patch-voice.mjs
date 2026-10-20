import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const root=fileURLToPath(new URL('../',import.meta.url))
const base=JSON.parse(readFileSync(join(root,'airi.lock.json'),'utf8'))
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:join(root,'vendor/airi'),encoding:'utf8'})
if(head.status!==0 || head.stdout.trim()!==base.commit)throw Error('AIRI voice overlay requires the pinned base')
const dest=join(root,'vendor/airi/packages/stage-ui/src/composables/use-cohost-voice.ts')
const src=readFileSync(join(root,'integrations/airi/use-cohost-voice.ts'))
for (const name of ['speech-pause.ts','speech-pause.test.ts','recognition-turns.ts','recognition-turns.test.ts','streaming-recognition.ts','streaming-recognition.test.ts','streaming-recognition.browser.test.ts']) {
  const target=join(root,'vendor/airi/packages/stage-ui/src/composables',name)
  const contents=readFileSync(join(root,'integrations/airi',name))
  const previous=join(root,'data/airi-overlay',name)
  if(existsSync(target)&&!readFileSync(target).equals(contents)&&(!existsSync(previous)||!readFileSync(target).equals(readFileSync(previous))))throw Error('Unsaved recognition edits')
  mkdirSync(dirname(target),{recursive:true});mkdirSync(dirname(previous),{recursive:true})
  if(!existsSync(target)||!readFileSync(target).equals(contents))writeFileSync(target,contents)
  writeFileSync(previous,contents)
}
const saved=join(root,'data/airi-overlay/shared-voice.ts')
const listeningPatch=spawnSync(process.execPath,[join(root,'scripts/patch-listening.mjs')],{cwd:root,stdio:'inherit',windowsHide:true})
if(listeningPatch.status!==0)throw Error('Listening overlay failed')
const pipelineTarget=join(root,'vendor/airi/packages/pipelines-audio/src/speech-pipeline.ts')
const pipelineSource=readFileSync(join(root,'integrations/airi/speech-pipeline.ts'))
const pipelinePrevious=join(root,'data/airi-overlay/speech-pipeline.ts')
const pipelineBase=spawnSync('git',['show','HEAD:packages/pipelines-audio/src/speech-pipeline.ts'],{cwd:join(root,'vendor/airi')})
if(pipelineBase.status!==0)throw Error('Cannot validate base speech pipeline')
const sameText=(left,right)=>left.toString('utf8').replaceAll('\r\n','\n')===right.toString('utf8').replaceAll('\r\n','\n')
for (const [name,path] of [['speech-eventa.ts','src/eventa.ts'],['tts-chunker.ts','src/processors/tts-chunker.ts'],['tts-source-text.test.ts','src/tts-source-text.test.ts']]) {
  const relative='packages/pipelines-audio/'+path
  const target=join(root,'vendor/airi',relative), previous=join(root,'data/airi-overlay',name)
  const contents=readFileSync(join(root,'integrations/airi',name))
  const original=spawnSync('git',['show','HEAD:'+relative],{cwd:join(root,'vendor/airi')})
  if(existsSync(target)&&!sameText(readFileSync(target),contents)&&!(original.status===0&&sameText(readFileSync(target),original.stdout))&&!(existsSync(previous)&&sameText(readFileSync(target),readFileSync(previous))))throw Error('Unsaved speech chunker edits: '+name)
  mkdirSync(dirname(previous),{recursive:true})
  writeFileSync(target,contents);writeFileSync(previous,contents)
}
if(existsSync(pipelineTarget)&&!sameText(readFileSync(pipelineTarget),pipelineSource)&&!sameText(readFileSync(pipelineTarget),pipelineBase.stdout)&&(!existsSync(pipelinePrevious)||!sameText(readFileSync(pipelineTarget),readFileSync(pipelinePrevious))))throw Error('Unsaved speech pipeline edits')
mkdirSync(dirname(pipelinePrevious),{recursive:true})
writeFileSync(pipelineTarget,pipelineSource);writeFileSync(pipelinePrevious,pipelineSource)
const speechTypesTarget=join(root,'vendor/airi/packages/pipelines-audio/src/types.ts')
const speechTypes=readFileSync(join(root,'integrations/airi/speech-types.ts'))
const speechTypesPrevious=join(root,'data/airi-overlay/speech-types.ts')
const speechTypesBase=spawnSync('git',['show','HEAD:packages/pipelines-audio/src/types.ts'],{cwd:join(root,'vendor/airi')})
if(speechTypesBase.status!==0)throw Error('Cannot validate base speech types')
if(existsSync(speechTypesTarget)&&!sameText(readFileSync(speechTypesTarget),speechTypes)&&!sameText(readFileSync(speechTypesTarget),speechTypesBase.stdout)&&(!existsSync(speechTypesPrevious)||!sameText(readFileSync(speechTypesTarget),readFileSync(speechTypesPrevious))))throw Error('Unsaved speech types edits')
writeFileSync(speechTypesTarget,speechTypes);writeFileSync(speechTypesPrevious,speechTypes)
const streamTestTarget=join(root,'vendor/airi/packages/pipelines-audio/src/speech-pipeline-stream.test.ts')
const streamTest=readFileSync(join(root,'integrations/airi/speech-pipeline-stream.test.ts'))
const streamTestPrevious=join(root,'data/airi-overlay/speech-pipeline-stream.test.ts')
if(existsSync(streamTestTarget)&&!sameText(readFileSync(streamTestTarget),streamTest)&&(!existsSync(streamTestPrevious)||!sameText(readFileSync(streamTestTarget),readFileSync(streamTestPrevious))))throw Error('Unsaved streaming speech tests')
writeFileSync(streamTestTarget,streamTest);writeFileSync(streamTestPrevious,streamTest)
if(existsSync(dest)&&!readFileSync(dest).equals(src)&&(!existsSync(saved)||!readFileSync(dest).equals(readFileSync(saved))))throw Error('Unsaved shared voice edits')
mkdirSync(dirname(dest),{recursive:true});mkdirSync(dirname(saved),{recursive:true})
if(!existsSync(dest)||!readFileSync(dest).equals(src))writeFileSync(dest,src)
writeFileSync(saved,src)
// AIRI imports this package through dist. Rebuild changed overlays before launch.
const audioRoot=join(root,'vendor/airi/packages/pipelines-audio')
const digest=paths=>{
  const hash=createHash('sha256')
  for(const path of paths){if(!existsSync(path))return null;hash.update(readFileSync(path))}
  return hash.digest('hex')
}
const inputs=digest(['src/speech-pipeline.ts','src/eventa.ts','src/types.ts','src/processors/tts-chunker.ts','tsdown.config.ts','package.json'].map(path=>join(audioRoot,path)))
const outputs=()=>digest(['dist/index.mjs','dist/index.d.mts'].map(path=>join(audioRoot,path)))
const stamp=join(root,'data/airi-overlay/audio-build.json')
let previousBuild
try {previousBuild=JSON.parse(readFileSync(stamp,'utf8'))}catch{}
if(!inputs||previousBuild?.inputs!==inputs||!outputs()||previousBuild?.outputs!==outputs()) {
  const built=spawnSync(process.execPath,[join(root,'vendor/airi/node_modules/tsdown/dist/run.mjs')],{cwd:audioRoot,stdio:'inherit',windowsHide:true})
  if(built.error||built.status!==0)throw Error('Cannot build AIRI speech overlays')
  writeFileSync(stamp,JSON.stringify({inputs,outputs:outputs()}))
}
const mediaPatch=spawnSync(process.execPath,[join(root,'scripts/patch-media.mjs')],{cwd:root,stdio:'inherit'})
if(mediaPatch.status!==0)throw Error('Media overlay failed')
