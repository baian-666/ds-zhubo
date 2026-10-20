import assert from 'node:assert/strict'
import {once} from 'node:events'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {createApp} from '../apps/cohost/server.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const folder=mkdtempSync(join(tmpdir(),'cohost-architecture-')),path=join(folder,'session.sqlite')
let server,base
async function start(){server=createApp({sessionPath:path,token:'',apiKey:'fixture',model:'deepseek-flash',airiOptions:{key:'fixture'},speechOptions:{engine:'index',fetchImpl:async()=>Response.json({ok:true,engine:'index-2.5'})},serviceOptions:{fetchImpl:async()=>Response.json({data:[{id:'new-model'}]})}});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port}
const get=async name=>(await fetch(base+'/api/'+name)).json()
const post=(name,body)=>fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100))}throw Error('Integration state did not settle')}
await start()
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],writes=[],requests=[]
async function createWindow(){
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1360,height:1000}})
 await context.addInitScript(()=>{localStorage.setItem('onboarding/completed','true');localStorage.setItem('cohost/enabled','true')})
 await context.route('http://127.0.0.1:8787/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;requests.push(path)
  if(path==='/api/characters'&&route.request().method()==='POST')writes.push({at:Date.now(),body:route.request().postDataJSON()})
  if(path==='/api/status/events')return route.continue({url:base+path})
  try{const response=await route.fetch({url:base+path});await route.fulfill({response})}catch{await route.abort().catch(()=>{})}
 })
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:5173/?cohost')
 await page.locator('[data-cohost-panel]').waitFor({timeout:120000});return page
}
const cardName=page=>page.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('airi-card').activeCard.name)
const edit=(page,name)=>page.evaluate(async name=>{const cards=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('airi-card');await cards.updateCard(cards.activeCardId,{...JSON.parse(JSON.stringify(cards.activeCard)),name,personality:'这是隔离浏览器中的角色',extensions:{...JSON.parse(JSON.stringify(cards.activeCard.extensions)),integrationProof:{preserved:true}}})},name)
try {
 const first=await createWindow();await until(async()=>(await get('characters')).catalog!==null)
 let saved=await get('characters');await post('characters',{revision:saved.catalog.revision,value:{...saved.catalog.value,bound:true}})
 await until(async()=>(await get('status')).configuration.cardId===saved.catalog.value.activeId)
 const second=await createWindow()
 await edit(first,'跨窗口角色一')
 await until(async()=>(await get('status')).configuration.persona==='跨窗口角色一'&&(await cardName(second))==='跨窗口角色一')
 await edit(second,'跨窗口角色二')
 await until(async()=>(await get('status')).configuration.persona==='跨窗口角色二'&&(await cardName(first))==='跨窗口角色二')
 saved=await get('characters');assert.equal(saved.catalog.value.cards.find(c=>c.id===saved.catalog.value.activeId).data.extensions.integrationProof.preserved,true)
 const writeCount=writes.length;await new Promise(resolve=>setTimeout(resolve,5500));assert.equal(writes.length,writeCount,'remote snapshots must not echo writes')
 for(const page of [first,second])assert.equal(await page.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('airi-card').cohostRepositoryError),'')
 await first.goto('http://127.0.0.1:5173/settings/modules/consciousness')
 const config=first.locator('[data-cohost-services]');await config.locator('[data-effective-service]').waitFor()
 await config.getByRole('textbox').fill('new-model');await config.getByRole('button',{name:'验证并保存',exact:true}).click()
 await until(async()=>(await get('services/config')).inference.value.model==='new-model')
 await first.goto('http://127.0.0.1:5173/settings/modules/hearing')
 await first.locator('[data-effective-service]').waitFor();assert.ok((await first.locator('[data-effective-service]').innerText()).includes('SenseVoiceSmall'))
 assert.equal((await get('status')).airi.capture,false)
 await first.screenshot({path:'data/finish-recognition-page.png'})
 await first.goto('http://127.0.0.1:5173/settings/modules/speech');await first.locator('[data-effective-speech]').waitFor()
 await new Promise(resolve=>setTimeout(resolve,1000));const count=requests.filter(path=>path==='/api/speech/config').length
 await new Promise(resolve=>setTimeout(resolve,2200));assert.equal(requests.filter(path=>path==='/api/speech/config').length,count,'idle settings must not poll')
 const before=(await get('characters')).catalog,model=(await get('services/config')).inference
 await new Promise(resolve=>server.close(resolve));await start()
 await until(async()=>await first.locator('[data-speech-persistence]').isVisible())
 assert.deepEqual((await get('characters')).catalog,before);assert.deepEqual((await get('services/config')).inference,model)
 assert.equal((await get('status')).configuration.persona,'跨窗口角色二');assert.deepEqual(errors,[])
 const result={twoWindowsConverge:true,unknownCardFieldsPreserved:true,catalogWrites:writes.length,noEchoWrites:true,noIdleSpeechPolling:true,inferenceSaved:true,recognitionPage:true,microphoneStarted:false,restartPreservesIdentityAndModel:true,pageErrors:errors}
 writeFileSync('data/finish-integration-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
} catch(error){writeFileSync('data/finish-integration-writes.json',JSON.stringify(writes,null,2));writeFileSync('data/finish-integration-errors.json',JSON.stringify(errors));throw error}
finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));rmSync(folder,{recursive:true,force:true})}
