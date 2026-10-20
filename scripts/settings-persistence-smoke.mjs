import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve,sep } from 'node:path'
import { createApp } from '../apps/cohost/server.mjs'

// The actual AIRI settings page uses an isolated SQLite runtime. No paid providers run.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const folder=mkdtempSync(join(tmpdir(),'cohost-settings-browser-')),path=join(folder,'session.sqlite')
const envPath=join(folder,'.env'),env='PRIVATE_TEST_KEY=unchanged-fixture\r\nCOHOST_TTS_PROVIDER=index\r\n'
writeFileSync(envPath,env)
let server,base
async function start() {
  server=createApp({sessionPath:path,apiKey:'',token:'',speechOptions:{engine:'index',voice:'local-reference',fetchImpl:async()=>Response.json({ok:true,engine:'index-2.5'})}})
  server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port
}
await start()
const browser=await chromium.launch({channel:'msedge',headless:true})
const context=await browser.newContext({viewport:{width:1360,height:1024},locale:'zh-CN'})
await context.addInitScript(()=>{localStorage.setItem('onboarding/completed','true');localStorage.setItem('cohost/enabled','true')})
await context.route('http://127.0.0.1:8787/api/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname
  if(endpoint==='/api/status/events')return route.continue({url:base+endpoint})
  try {const response=await route.fetch({url:base+endpoint});await route.fulfill({response})}
  catch {await route.abort().catch(()=>{})}
})
const errors=[]
const get=async endpoint=>(await fetch(base+'/api/'+endpoint)).json()
const post=(endpoint,body)=>fetch(base+'/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
async function until(fn) {for(let i=0;i<150;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100))}throw Error('Settings did not settle')}
try {
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:5173/settings/modules/speech')
  const panel=page.locator('[data-cohost-speech]');await panel.waitFor({timeout:120000})
  await until(async()=> (await panel.locator('[data-speech-persistence]').textContent()).includes('已保存在本机'))
  await panel.getByRole('combobox').first().click()
  await page.getByRole('option',{name:'FunAudioLLM/CosyVoice2-0.5B',exact:true}).click()
  await until(async()=> (await get('speech/config')).effective.engine==='siliconflow')
  await until(async()=> (await panel.getByRole('combobox').count())===2)
  await panel.getByRole('combobox').nth(1).click()
  await page.getByRole('option',{name:'anna',exact:true}).click()
  await until(async()=> (await get('speech/config')).effective.voice==='anna')
  const saved=await get('speech/config')
  await new Promise(resolve=>server.close(resolve));await start()
  await until(async()=> (await panel.locator('[data-effective-speech]').textContent()).includes('anna'))
  const after=await get('speech/config');assert.equal(after.effective.revision,saved.effective.revision)
  const state=await get('status');assert.equal((await post('reset',{session:state.room.session})).status,200)
  assert.equal((await get('speech/config')).effective.revision,saved.effective.revision)
  assert.equal(readFileSync(envPath,'utf8'),env)
  assert.deepEqual(errors,[])
  await panel.screenshot({path:'data/configuration-settings-browser.png'})
  const result={storage:after.persistence.storage,voice:after.effective.voice,restartRevisionPreserved:true,clearPreservesSettings:true,envUnchanged:true,pageErrors:errors}
  writeFileSync('data/configuration-settings-browser-result.json',JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
} finally {
  await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
  assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));rmSync(folder,{recursive:true,force:true})
}
