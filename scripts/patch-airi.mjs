import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { performanceContracts, performanceSource } from './performance-overlay.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const vendor=join(root,'vendor/airi')
const lock=JSON.parse(readFileSync(join(root,'airi.lock.json'),'utf8'))
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:vendor,encoding:'utf8'})
if(head.status!==0 || head.stdout.trim()!==lock.commit)throw new Error('AIRI revision differs from the pinned base')
const localModel=join(root,'data/live2d/whale-airi.zip')
if(existsSync(localModel)) {
  const publicDir=join(vendor,'apps/stage-web/public')
  mkdirSync(publicDir,{recursive:true})
  const modelDestination=join(publicDir,'cohost-whale.zip')
  const modelBytes=readFileSync(localModel)
  const fingerprint=bytes=>createHash('sha256').update(bytes).digest('hex')
  const savedHash=join(root,'data/airi-overlay/cohost-whale.sha256')
  if(existsSync(modelDestination)&&!readFileSync(modelDestination).equals(modelBytes)&&
    (!existsSync(savedHash)||fingerprint(readFileSync(modelDestination))!==readFileSync(savedHash,'utf8')))
    throw new Error('Local AIRI model copy has unsaved edits')
  if(!existsSync(modelDestination)||!readFileSync(modelDestination).equals(modelBytes))writeFileSync(modelDestination,modelBytes)
  mkdirSync(join(root,'data/airi-overlay'),{recursive:true});writeFileSync(savedHash,fingerprint(modelBytes))
}
const destination=join(vendor,'apps/stage-web/src/cohost')
mkdirSync(destination,{recursive:true})
for(const name of [...performanceContracts,'whale-capabilities.ts','cohost-contract.ts','use-cohost-performance.ts','motion-sequence.ts','whale-rig.ts','rig-controller.ts','pose-control.ts']) {
  // Node requires source extensions; Vite/tsc resolve the renderer's extensionless imports.
  const source=performanceSource(name)
  const path=join(destination,name)
  // Owned overlay files can be updated only when they match the previous installation.
  const saved=join(root,'data/airi-overlay',name)
  if(existsSync(path) && !readFileSync(path).equals(source) && (!existsSync(saved)||!readFileSync(path).equals(readFileSync(saved))))throw new Error('AIRI overlay has unsaved edits: '+name)
  if(!existsSync(path) || !readFileSync(path).equals(source)) writeFileSync(path,source)
  mkdirSync(join(root,'data/airi-overlay'),{recursive:true});writeFileSync(saved,source)
}
const rigPatch=spawnSync(process.execPath,[join(root,'scripts/patch-rig.mjs')],{cwd:root,stdio:'inherit'})
if(rigPatch.status!==0)throw new Error('Shared rig overlay failed')
const app=join(vendor,'apps/stage-web/src/App.vue')
let source=readFileSync(app,'utf8')
const anchor="import { usePWAStore } from './stores/pwa'"
const added="import { useCohostPerformance } from './cohost/use-cohost-performance'"
if(!source.includes(added)) {
  if(!source.includes(anchor))throw new Error('AIRI App anchor changed')
  source=source.replace(anchor,added+'\n'+anchor).replace('usePWAStore()','usePWAStore()\nuseCohostPerformance()')
  writeFileSync(app,source)
}
const voicePatch=spawnSync(process.execPath,[join(root,'scripts/patch-voice.mjs')],{cwd:root,stdio:'inherit'})
if(voicePatch.status!==0)throw new Error('Shared voice overlay failed')
console.log('Applied the pinned AIRI shared cohost overlay.')
const consolePatch=spawnSync(process.execPath,[join(root,'scripts/patch-console.mjs')],{cwd:root,stdio:'inherit'})
if(consolePatch.status!==0)throw new Error('Live room panel overlay failed')
