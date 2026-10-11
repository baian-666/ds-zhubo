import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server=createApp({apiKey:'',token:''})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1500,height:1100}})
const errors=[],warnings=[]
page.on('pageerror',e=>errors.push(e.message))
page.on('console',m=>{if(m.type()==='error')warnings.push(m.text())})
await page.addInitScript(()=>{if(location.origin==='http://127.0.0.1:5173'){localStorage.setItem('onboarding/completed','true');localStorage.setItem('onboarding/skipped','false')}})
try {
 await page.goto(base)
 await page.locator('#stage').waitFor()
 const frame=await page.locator('#stage').elementHandle().then(handle=>handle.contentFrame())
 assert.ok(frame)
 await frame.waitForFunction(()=>{
  const app=document.querySelector('#app')?.__vue_app__
  const s=app?.config.globalProperties.$pinia._s.get('live2d-expressions')
  return s?.expressionGroups.size===44 && localStorage.getItem('settings/stage/model')?.startsWith('display-model-')
 },null,{timeout:90000})
 async function state(){
  return await frame.evaluate(()=>{
   const stores=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
   const e=stores.get('live2d-expressions'),m=stores.get('live2d-motion-control')
   return {model:e.modelId,count:e.expressionGroups.size,active:m.control.active,pose:JSON.parse(JSON.stringify(m.control.pose)),
    question:e.expressions.get('ParamCheek74')?.currentValue,excited:e.expressions.get('ParamCheek76')?.currentValue,
    surprise:e.expressions.get('ParamCheek75')?.currentValue,angry:e.expressions.get('ParamCheek80')?.currentValue}
  })
 }
 await page.locator('#performanceState').filter({hasText:'角色已连接'}).waitFor()
 const results=[]
 for(const [pose,field,expression] of [['smile','excited','开心兴奋'],['surprise','surprise','感叹号'],['think','question','问号'],['pout','angry','生气']]){
  await page.locator('[data-pose='+pose+']').click()
  await page.locator('#performanceState').filter({hasText:'表情：'+expression}).waitFor()
  const current=await state();assert.equal(current[field],1)
  for(const other of ['question','excited','surprise','angry'].filter(x=>x!==field))assert.equal(current[other],0)
  await page.waitForTimeout(450);await page.screenshot({path:'data/whale-web-'+pose+'.png',fullPage:true})
  results.push({command:pose,...current})
 }
 // Expression writes must not freeze the speech mouth.
 const mouth=await frame.evaluate(async()=>{
  let element=document.querySelector('canvas');while(element&&!element.__vueParentComponent)element=element.parentElement
  let scene=element.__vueParentComponent;while(scene&&scene.type.__name!=='Live2D')scene=scene.parent
  const raw=scene.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState
  let stage=scene.parent;while(stage&&stage.type.__name!=='Stage')stage=stage.parent
  const speech=stage.devtoolsRawSetupState
  speech.nowSpeaking.value=true;speech.mouthOpenSize.value=0.65
  await new Promise(r=>setTimeout(r,150))
  const peak=raw.model.value.internalModel.coreModel.getParameterValueById('ParamMouthOpenY')
  speech.nowSpeaking.value=false;speech.mouthOpenSize.value=0
  await new Promise(r=>setTimeout(r,800))
  const rest=raw.model.value.internalModel.coreModel.getParameterValueById('ParamMouthOpenY')
  return {peak,rest}
 })
 assert.ok(mouth.peak>0.5);assert.ok(mouth.rest<0.05)
 await page.locator('[data-pose=nod]').click()
 await page.locator('#performanceState').filter({hasText:'点头'}).waitFor()
 const first=await state();await page.waitForTimeout(220);const second=await state()
 assert.notEqual(first.pose.headY,second.pose.headY);assert.equal(second.angry,0)
 await page.locator('#performanceState').filter({hasText:'待机'}).waitFor()
 assert.equal((await state()).active,false)
 // An operator edit made after the command remains intact when it ends.
 await page.locator('[data-pose=surprise]').click()
 await page.locator('#performanceState').filter({hasText:'表情：感叹号'}).waitFor()
 await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').set('ParamCheek75',0.5))
 await page.locator('[data-pose=idle]').click()
 await page.locator('#performanceState').filter({hasText:'待机'}).waitFor()
 assert.equal((await state()).surprise,0.5)
 await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').set('ParamCheek75',0))
 await page.locator('[data-pose=think]').click()
 await page.locator('#performanceState').filter({hasText:'表情：问号'}).waitFor()
 await page.route('**/api/status',r=>r.abort())
 await page.waitForTimeout(2100)
 const disconnected=await state();assert.equal(disconnected.question,0);assert.equal(disconnected.active,false)
 const selected=disconnected.model
 await frame.evaluate(()=>location.reload())
 await frame.waitForFunction(id=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.modelId===id,selected,{timeout:45000})
 const persisted=await state();assert.equal(persisted.model,selected);assert.equal(persisted.count,44)
 const importedCount=await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('display-models').displayModels.filter(model=>model.type==='file').length)
 assert.equal(importedCount,1)
 assert.deepEqual(errors,[])
 const report={pass:true,results,mouth,disconnected,persisted,importedCount,errors,warnings}
 writeFileSync('data/whale-web-result.json',JSON.stringify(report,null,2))
 console.log(JSON.stringify({pass:true,model:disconnected.model,count:disconnected.count,mouth,errors,warnings}))
}catch(error){await page.screenshot({path:'data/whale-web-failure.png',fullPage:true});throw error}
finally{await browser.close();server.close();server.closeAllConnections()}