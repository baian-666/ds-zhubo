import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createApp } from '../apps/cohost/server.mjs'

// Browser interaction uses an isolated database and synthetic model output.
// No production conversation, settings, microphone, or paid provider is touched.
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const folder=mkdtempSync(join(tmpdir(),'cohost-session-browser-'))
const path=join(folder,'session.sqlite')
let server,browser,base,observed
const reply=async function*(request){observed=request;yield '记住了，今天聊的是钓鱼。'}
const deferred='稍后聊河边钓鱼的事'
async function start() {
  server=createApp({sessionPath:path,apiKey:'fixture',token:'',reply,semanticEnabled:true,participationOptions:{debounceMs:1},
    planner:async()=>({action:'wait',hostIntent:'none',text:'',targetId:'',platform:'',reason:'等主播打完这局再聊。',continuation:{action:'defer',text:'河边钓鱼的事',quote:deferred}})})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  base=`http://127.0.0.1:${server.address().port}`
}
async function stop() {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
const post=(endpoint,body)=>fetch(base+'/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
const status=()=>fetch(base+'/api/status').then(response=>response.json())
async function until(check) {
  for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}
  throw new Error('Fixture state did not settle')
}
try {
  await start()
  await (await post('reply',{source:'host',text:'今天聊钓鱼'})).text()
  await post('director/event',{type:'mode',value:'auto'})
  for(const body of [{type:'speech-start',utterance:50},{type:'transcript',utterance:50,text:deferred,final:true},{type:'speech-end',utterance:50}])await post('director/event',body)
  await until(async()=>{const memory=(await status()).sessionMemory.continuity;return memory.items.length===1 && memory.summary.length>0})
  await stop();await start()
  browser=await chromium.launch({channel:'msedge',headless:true})
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1060,height:1000}})
  await context.addInitScript(()=>{localStorage.setItem('onboarding/completed','true');localStorage.setItem('cohost/enabled','true')})
  await context.route('http://127.0.0.1:8787/api/**',async route=>{
    const endpoint=new URL(route.request().url()).pathname
    if(endpoint==='/api/status/events')return route.continue({url:base+endpoint})
    const response=await route.fetch({url:base+endpoint})
    await route.fulfill({response})
  })
  const page=await context.newPage(),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:5173/settings/modules/cohost')
  const panel=page.locator('[data-session-memory]')
  await panel.getByText('已恢复本场记录；旧语音和动作不会重播。',{exact:true}).waitFor({timeout:90000})
  assert.match(await panel.innerText(),/最近 1 轮/)
  await panel.locator('[data-session-continuity] > summary').click()
  const item=panel.locator('[data-continuation-item]')
  await item.getByText('属于旧话题，等主播明确接回来。',{exact:true}).waitFor()
  assert.match(await item.innerText(),/稍后聊河边钓鱼的事/)
  await item.screenshot({path:'data/continuity-web-item.png'})
  await item.getByRole('button',{name:'移除这项',exact:true}).click()
  await panel.getByText('没有待续事项。',{exact:true}).waitFor()
  await panel.getByRole('button',{name:'清除当前摘要',exact:true}).click()
  await panel.getByText('还没有摘要，新对话后会在空闲时整理。',{exact:true}).waitFor()
  await stop();await start()
  assert.deepEqual((await status()).sessionMemory.continuity.items,[])
  assert.deepEqual((await status()).sessionMemory.continuity.summary,[])
  await panel.getByRole('button',{name:'清空本场，重新开始',exact:true}).click()
  await panel.getByRole('button',{name:'保留本场',exact:true}).click()
  assert.equal((await status()).sessionMemory.turns,1)
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({path:'data/session-memory-web.png'})
  await panel.getByRole('button',{name:'清空本场，重新开始',exact:true}).click()
  await panel.getByRole('button',{name:'确认清空本场',exact:true}).click()
  await panel.getByText(/最近 0 轮/).waitFor()
  await stop();await start()
  await (await post('reply',{source:'host',text:'新场次'})).text()
  assert.deepEqual(observed.history,[])
  assert.equal(JSON.stringify(observed.scene).includes('今天聊钓鱼'),false)
  assert.deepEqual(errors,[])
  const result={restored:true,keptOnCancel:true,clearedAfterRestart:true,summaryAndItemsVisible:true,removedAfterRestart:true,pageErrors:errors,providers:'synthetic',productionDataChanged:false}
  writeFileSync('data/session-memory-browser.json',JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  if(server?.listening)await stop()
  assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep))
  rmSync(folder,{recursive:true,force:true})
}
