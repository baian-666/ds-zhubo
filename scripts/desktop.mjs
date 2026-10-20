import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { airiEnvironment } from './airi-toolchain.mjs'
import { activateDesktopBuild, desktopEntryHashes, desktopRelease, digestFile, readDesktopBuild, serveDesktopRenderer } from './desktop-artifact.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const vendor=join(root,'vendor/airi')
const pnpm=join(root,'data/toolchains/pnpm-11.24.0/node_modules/pnpm/bin/pnpm.cjs')
const lock=JSON.parse(readFileSync(join(root,'airi.lock.json'),'utf8'))
const action=process.argv[2] ?? 'start'
const appRoot=join(vendor,'apps/stage-tamagotchi')
const pointer=join(root,'data/desktop-build.json')
if(process.versions.node!==lock.node) throw new Error('Use the pinned local Node toolchain')
const env=airiEnvironment({DS_ZHUBO_DESKTOP:'1',APP_USER_DATA_PATH:join(root,'data/desktop-profile'),APP_REMOTE_DEBUG_NO_OPEN:'true'})
delete env.DEEPSEEK_API_KEY
delete env.SILICONFLOW_API_KEY
delete env.DASHSCOPE_API_KEY
if(action==='start' || action==='dev') {
 if(existsSync(join(root,'.env'))) {
  const local=parseEnv(readFileSync(join(root,'.env'),'utf8'))
  if(local.COHOST_ACCESS_TOKEN)env.COHOST_ACCESS_TOKEN=local.COHOST_ACCESS_TOKEN
 }
}
// Build processes never receive the local backend credential.
else delete env.COHOST_ACCESS_TOKEN
mkdirSync(env.APP_USER_DATA_PATH,{recursive:true})
function run(args,cwd=vendor) {
 const result=spawnSync(process.execPath,args,{cwd,env,stdio:'inherit',windowsHide:true})
 if(result.error||result.status!==0)throw new Error('Desktop command failed: '+(result.error?.message??result.status))
}
if(action==='start') {
 if(!existsSync(pointer))throw Error('尚无固定桌面构建，请先运行 更新桌面构建.cmd。')
 const {active}=JSON.parse(readFileSync(pointer,'utf8'))
 const {folder,manifest}=readDesktopBuild(appRoot,active)
 if(manifest.airiCommit!==lock.commit || manifest.lockHash!==digestFile(join(vendor,'pnpm-lock.yaml')))
   throw Error('桌面依赖版本已变化，请重新运行 更新桌面构建.cmd。')
 const started=performance.now()
 const server=await serveDesktopRenderer(join(folder,'renderer'),{health:()=>({build:active,pid:process.pid,uptimeMs:Math.round(performance.now()-started)})})
 try {
  const require=createRequire(join(appRoot,'package.json'))
  const electron=require('electron')
  env.ELECTRON_RENDERER_URL='http://localhost:5174'
  delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(electron,[folder],{cwd:appRoot,env,stdio:'inherit',windowsHide:true})
  const stop=()=>child.kill()
  process.once('SIGTERM',stop);process.once('SIGINT',stop)
  console.log('Fixed desktop build:',active)
  process.exitCode=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',code=>accept(code??1))})
  process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)
 } finally { server.closeAllConnections();await new Promise(accept=>server.close(accept)) }
} else if(action==='rollback') {
 const {previous}=JSON.parse(readFileSync(pointer,'utf8'))
 if(!previous)throw Error('尚无可回退的桌面构建。')
 activateDesktopBuild(pointer,appRoot,previous)
 console.log('Desktop build selected:',previous)
} else {
 const head=spawnSync('git',['rev-parse','HEAD'],{cwd:vendor,env,encoding:'utf8'})
 if(head.status!==0||head.stdout.trim()!==lock.commit)throw new Error('AIRI revision differs from airi.lock.json')
if(action==='setup') {
 run([pnpm,'--filter','@proj-airi/stage-tamagotchi...','install','--frozen-lockfile','--ignore-scripts'])
 run([pnpm,'-r','--filter','@proj-airi/stage-tamagotchi^...','--workspace-concurrency=2','--if-present','run','build'])
 run([pnpm,'-F','@proj-airi/stage-tamagotchi','exec','install-electron'])
} else {
 if(!['dev','check','build'].includes(action))throw new Error('Use setup, dev, check or build')
 const workspaceBefore=readFileSync(join(vendor,'pnpm-workspace.yaml'))
 run([join(root,'scripts/patch-desktop.mjs')],root)
 if(!workspaceBefore.equals(readFileSync(join(vendor,'pnpm-workspace.yaml'))))
   run([pnpm,'install','--frozen-lockfile','--ignore-scripts'])
 if(action==='check')run([pnpm,'-F','@proj-airi/stage-tamagotchi','typecheck'])
 else if(action==='dev')run([pnpm,'-F','@proj-airi/stage-tamagotchi','exec','electron-vite','dev'])
 else {
  const id=new Date().toISOString().replaceAll(/[-:.]/g,'')+'-'+randomBytes(4).toString('hex')
  const folder=desktopRelease(appRoot,id)
  mkdirSync(folder,{recursive:true})
  env.DS_ZHUBO_BUILD_DIR=folder
  // Bound native bundler parallelism. The full renderer also includes WASM workers and model assets.
  env.RAYON_NUM_THREADS='2'
  env.NODE_OPTIONS=((env.NODE_OPTIONS??'').replace(/--max-old-space-size(?:=|\s+)\d+/g,'')+' --max-old-space-size=8192').trim()
  run([pnpm,'-F','@proj-airi/stage-tamagotchi','exec','electron-vite','build'])
  // Electron's asset imports address resources relative to the compiled main directory.
  // The build also retains workspace dependencies through its parent app directory.
  cpSync(join(appRoot,'resources'),join(folder,'resources'),{recursive:true})
  writeFileSync(join(folder,'package.json'),JSON.stringify({name:'ds-zhubo-desktop',version:'0.1.0',type:'module',main:'./main/index.js'}))
  writeFileSync(join(folder,'build.json'),JSON.stringify({format:1,id,builtAt:new Date().toISOString(),airiCommit:lock.commit,node:process.versions.node,lockHash:digestFile(join(vendor,'pnpm-lock.yaml')),entries:desktopEntryHashes(folder)},null,2)+'\n')
  activateDesktopBuild(pointer,appRoot,id)
  console.log('Fixed desktop build ready:',id)
 }
}
}
