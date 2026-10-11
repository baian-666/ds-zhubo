import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root=fileURLToPath(new URL('../',import.meta.url))
const vendor=join(root,'vendor/airi')
const lock=JSON.parse(readFileSync(join(root,'airi.lock.json'),'utf8'))
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:vendor,encoding:'utf8'})
if(head.status!==0 || head.stdout.trim()!==lock.commit)throw new Error('AIRI revision differs from the pinned base')
const destination=join(vendor,'apps/stage-web/src/cohost')
mkdirSync(destination,{recursive:true})
for(const name of ['cohost-contract.ts','cohost-parent.ts','use-cohost-performance.ts']) {
  const source=readFileSync(join(root,'integrations/airi',name))
  const path=join(destination,name)
  // Owned overlay files can be updated only when they match the previous installation.
  const saved=join(root,'data/airi-overlay',name)
  if(existsSync(path) && !readFileSync(path).equals(source) && (!existsSync(saved)||!readFileSync(path).equals(readFileSync(saved))))throw new Error('AIRI overlay has unsaved edits: '+name)
  if(!existsSync(path) || !readFileSync(path).equals(source)) writeFileSync(path,source)
  mkdirSync(join(root,'data/airi-overlay'),{recursive:true});writeFileSync(saved,source)
}
const app=join(vendor,'apps/stage-web/src/App.vue')
let source=readFileSync(app,'utf8')
const anchor="import { usePWAStore } from './stores/pwa'"
const added="import { useCohostPerformance } from './cohost/use-cohost-performance'"
if(!source.includes(added)) {
  if(!source.includes(anchor))throw new Error('AIRI App anchor changed')
  source=source.replace(anchor,added+'\n'+anchor).replace('usePWAStore()','usePWAStore()\nuseCohostPerformance()')
  writeFileSync(app,source)
}
const require=createRequire(join(vendor,'apps/stage-web/package.json'))
const viteRequire=createRequire(require.resolve('vite'))
const esbuild=await import(pathToFileURL(viteRequire.resolve('esbuild')))
const bundle=await esbuild.build({metafile:true,entryPoints:[join(destination,'cohost-parent.ts')],bundle:true,format:'esm',minify:true,
  outfile:join(root,'apps/cohost/stage-bridge.mjs'),legalComments:'eof'})
writeFileSync(join(root,'data/airi-overlay/bundle-inputs.json'),JSON.stringify(bundle.metafile.inputs,null,2))
const voicePatch=spawnSync(process.execPath,[join(root,'scripts/patch-voice.mjs')],{cwd:root,stdio:'inherit'})
if(voicePatch.status!==0)throw new Error('Shared voice overlay failed')
console.log('Applied pinned AIRI cohost overlay and rebuilt the parent bridge.')
