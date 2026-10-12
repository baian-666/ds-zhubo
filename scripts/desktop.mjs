import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const root=fileURLToPath(new URL('../',import.meta.url))
const vendor=join(root,'vendor/airi')
const pnpm=join(root,'data/toolchains/pnpm-11.24.0/node_modules/pnpm/bin/pnpm.cjs')
const lock=JSON.parse(readFileSync(join(root,'airi.lock.json'),'utf8'))
const action=process.argv[2] ?? 'dev'
if(process.versions.node!==lock.node) throw new Error('Use the pinned local Node toolchain')
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:vendor,encoding:'utf8'})
if(head.status!==0||head.stdout.trim()!==lock.commit)throw new Error('AIRI revision differs from airi.lock.json')
const env={...process.env,DS_ZHUBO_DESKTOP:'1',APP_USER_DATA_PATH:join(root,'data/desktop-profile'),APP_REMOTE_DEBUG_NO_OPEN:'true'}
delete env.DEEPSEEK_API_KEY
delete env.SILICONFLOW_API_KEY
if(existsSync(join(root,'.env'))) {
  const local=parseEnv(readFileSync(join(root,'.env'),'utf8'))
  if(local.COHOST_ACCESS_TOKEN)env.COHOST_ACCESS_TOKEN=local.COHOST_ACCESS_TOKEN
}
mkdirSync(env.APP_USER_DATA_PATH,{recursive:true})
function run(args,cwd=vendor) {
 const result=spawnSync(process.execPath,args,{cwd,env,stdio:'inherit',windowsHide:true})
 if(result.error||result.status!==0)throw new Error('Desktop command failed: '+(result.error?.message??result.status))
}
if(action==='setup') {
 run([pnpm,'--filter','@proj-airi/stage-tamagotchi...','install','--frozen-lockfile','--ignore-scripts'])
 run([pnpm,'-r','--filter','@proj-airi/stage-tamagotchi^...','--workspace-concurrency=2','--if-present','run','build'])
 run([pnpm,'-F','@proj-airi/stage-tamagotchi','exec','install-electron'])
} else {
 if(!['dev','check','build'].includes(action))throw new Error('Use setup, dev, check or build')
 run([join(root,'scripts/patch-desktop.mjs')],root)
 if(action==='check')run([pnpm,'-F','@proj-airi/stage-tamagotchi','typecheck'])
 else run([pnpm,'-F','@proj-airi/stage-tamagotchi','exec','electron-vite',action==='dev'?'dev':'build'])
}
