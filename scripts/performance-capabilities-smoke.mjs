import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'

// An isolated backend and browser use the real local whale model. No production settings or providers are touched.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const server=createApp({apiKey:'fixture',token:'',reply:async function*(){yield '语音和接话由独立链路处理。'}})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const context=await browser.newContext({viewport:{width:1500,height:1050},locale:'zh-CN'})
const errors=[],publications=[]
await context.addInitScript(()=>{
  localStorage.setItem('onboarding/completed','true')
  localStorage.setItem('cohost/enabled','true')
})
await context.route('http://127.0.0.1:8787/api/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/api/runtime-profile')publications.push(route.request().postDataJSON())
  if(path==='/api/status/events')return route.continue({url:base+path})
  await route.fulfill({response:await route.fetch({url:base+path})})
})
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
const post=async(path,body)=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json()}
const status=()=>fetch(base+'/api/status').then(r=>r.json())
const result={kind:'real browser and local whale model; synthetic commands; no model or speech provider calls',errors}
let frame
try {
  await page.goto(base)
  frame=await page.locator('#stage').elementHandle().then(h=>h.contentFrame())
  await frame.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressions.has('Param_Angle_Rotation_1_B_tail3'),null,{timeout:120000})
  await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').setLlmMode('all'))
  for(let n=0;n<100&&!publications.at(-1)?.capabilities.components.some(x=>x.name==='tailBase');n++)await page.waitForTimeout(100)
  const caps=publications.at(-1)?.capabilities
  assert.ok(caps);assert.equal(caps.expressions.length,44);assert.equal(caps.components.length,27)
  result.capabilities={adapter:caps.adapter,expressions:caps.expressions.length,components:caps.components.length}
  const state=()=>frame.evaluate(()=>{
    const stores=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    const expressions=stores.get('live2d-expressions'),motion=stores.get('live2d-motion-control')
    let element=document.querySelector('canvas');while(element&&!element.__vueParentComponent)element=element.parentElement
    let scene=element.__vueParentComponent;while(scene&&scene.type.__name!=='Live2D')scene=scene.parent
    const core=scene.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState.model.value.internalModel.coreModel
    return {active:motion.control.active,happy:expressions.expressions.get('ParamCheek76').currentValue,star:expressions.expressions.get('ParamCheek16').currentValue,
      tail:core.getParameterValueById('Param_Angle_Rotation_1_B_tail3'),mouth:core.getParameterValueById('ParamMouthOpenY'),
      omelet:core.getParameterValueById('danbaofan'),board:core.getParameterValueById('point'),squeeze:core.getParameterValueById('ji')}
  })
  const play=motion=>post('performance',{name:'sequence',motion})
  result.beforeOmelet=await state()
  await play({label:'笑着端蛋包饭挤酱',frames:[{ms:300,holdMs:1800,pose:{},expression:{name:'smile',strength:1},components:{omelet:1,squeeze:0.6}}]})
  await page.waitForTimeout(850)
  result.omelet=await state()
  assert.equal(result.omelet.omelet,1)
  assert.equal(result.omelet.board,0)
  assert.equal(result.omelet.happy,1)
  assert.ok(Math.abs(result.omelet.squeeze-0.6)<0.01)
  await page.screenshot({path:'data/performance-omelet-stage.png'})
  await page.waitForTimeout(1800)
  result.omeletReleased=await state()
  assert.equal(result.omeletReleased.omelet,result.beforeOmelet.omelet)
  assert.equal(result.omeletReleased.board,result.beforeOmelet.board)
  await play({label:'轻笑摇尾',frames:[{ms:300,holdMs:1400,pose:{headZ:0.15},expression:{name:'smile',strength:0.7},components:{tailBase:0.3}}]})
  await frame.waitForFunction(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').expressions.get('ParamCheek76').currentValue===1)
  await page.waitForTimeout(350)
  result.active=await state();assert.ok(result.active.active);assert.ok(Math.abs(result.active.tail-13.5)<0.1)
  await page.screenshot({path:'data/performance-capabilities-stage.png'})
  await page.waitForTimeout(1500);result.released=await state();assert.equal(result.released.active,false);assert.equal(result.released.happy,0)
  await play({label:'眼型互斥',frames:[{ms:200,holdMs:500,pose:{},expression:{name:'星星眼',strength:0.3}},{ms:300,holdMs:900,pose:{},expression:{name:'smile',strength:0.25}}]})
  result.eyeSamples=[]
  for(let n=0;n<22;n++){
    const sample=await state();assert.ok(sample.happy+sample.star<=1.001);result.eyeSamples.push({happy:sample.happy,star:sample.star});await page.waitForTimeout(65)
  }
  assert.ok(result.eyeSamples.some(x=>x.star===1));assert.ok(result.eyeSamples.some(x=>x.happy===1))
  await play({label:'撤销权限',frames:[{ms:300,holdMs:1800,pose:{},expression:{name:'smile',strength:1},components:{tailBase:0.3}}]})
  await page.waitForTimeout(500)
  await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').setLlmMode('none'))
  await page.waitForTimeout(350);result.revoked=await state();assert.equal(result.revoked.active,false);assert.equal(result.revoked.happy,0)
  await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').setLlmMode('all'))
  await page.waitForTimeout(550);assert.equal((await state()).active,false,'Permission restoration must not revive the old command')
  await post('performance',{name:'nod'});await page.waitForTimeout(600);assert.ok((await state()).active)
  // Stop both status transports to exercise the short stage lease.
  await page.route(base+'/api/status',route=>route.abort())
  await page.route(base+'/api/stage-performance',route=>route.abort())
  await page.waitForTimeout(1900);assert.equal((await state()).active,false)
  assert.deepEqual(errors,[]);result.pass=true
  console.log(JSON.stringify({pass:true,...result.capabilities,eyeExclusivity:true,permissionRevocation:true,leaseRelease:true,errors}))
}catch(error){result.pass=false;result.error=error.message;result.publications=publications.slice(-2);result.status=await status();await page.screenshot({path:'data/performance-capabilities-failure.png'}).catch(()=>{});throw error}
finally {writeFileSync('data/performance-capabilities-browser.json',JSON.stringify(result,null,2));await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
