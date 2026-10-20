import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { airiEnvironment } from './airi-toolchain.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const vendor=join(root,'vendor/airi')
const lock=JSON.parse(readFileSync(join(root,'airi.lock.json'),'utf8'))
if(process.versions.node!==lock.node)throw Error('Use the pinned local Node toolchain')
const env=airiEnvironment({CI:'true'})
env.NODE_OPTIONS=((env.NODE_OPTIONS??'')+' --no-experimental-webstorage').trim()
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:vendor,env,encoding:'utf8'})
if(head.status!==0||head.stdout.trim()!==lock.commit)throw Error('AIRI revision differs from airi.lock.json')
const steps={
  typecheck:['typecheck','--continue=always'],lint:['lint'],build:['build:packages','--continue=always'],
  'test-root':['exec','vitest','run','--maxWorkers=2'],
  'test-desktop':['exec','vitest','run','--config','apps/stage-tamagotchi/vitest.config.ts','--project','browser','--maxWorkers=2'],
  'test-web':['-F','@proj-airi/stage-web','exec','vitest','run','--project','browser','src/pages/devtools/vrm-model-position.browser.test.ts','--maxWorkers=2'],
  'test-pages':['-F','@proj-airi/stage-pages','test:run','--maxWorkers=2'],
  'test-ui':['exec','vitest','run','--config','packages/stage-ui/vitest.config.ts','--maxWorkers=2'],
  'test-live2d':['exec','vitest','run','--config','packages/stage-ui-live2d/vitest.config.ts','--project','browser','--maxWorkers=2'],
}
const selected=process.argv[2]??'all'
if(!['all','test'].includes(selected)&&!Object.hasOwn(steps,selected))throw Error('Use all, typecheck, lint, build, test or a test group')
const patch=spawnSync(process.execPath,[join(root,'scripts/patch-checks.mjs')],{cwd:root,env,stdio:'inherit',windowsHide:true})
if(patch.status!==0)throw Error('Check overlay could not be applied')
mkdirSync(join(root,'data'),{recursive:true})
const results=[]
for(const [name,args] of Object.entries(steps)) {
  if(selected!=='all'&&selected!==name&&!(selected==='test'&&name.startsWith('test-')))continue
  const log=join(root,'data',`airi-check-${name}.log`)
  const fd=openSync(log,'w')
  console.log(`AIRI ${name}: running. Log: ${log}`)
  let result
  try {
    result=spawnSync(process.platform==='win32'?process.execPath:'pnpm',process.platform==='win32'?[join(root,'data/toolchains/pnpm-11.24.0/node_modules/pnpm/bin/pnpm.cjs'),...args]:args,{cwd:vendor,env,stdio:['ignore',fd,fd],windowsHide:true})
  } finally {closeSync(fd)}
  results.push({name,exitCode:result.status,log,error:result.error?.code})
  console.log(`AIRI ${name}: ${result.status===0?'passed':'failed'}`)
}
writeFileSync(join(root,'data','airi-checks-summary.json'),JSON.stringify({commit:lock.commit,results},null,2)+'\n')
process.exitCode=results.every(result=>result.exitCode===0)?0:1
