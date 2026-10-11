import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const captureOnly=process.argv.includes('--capture-only')
const app=createApp({apiKey:'',token:''});app.listen(0,'127.0.0.1');await once(app,'listening')
const base='http://127.0.0.1:'+app.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1500,height:1100}})
const errors=[];page.on('pageerror',error=>errors.push(error.message))
await page.addInitScript(()=>{if(location.origin==='http://127.0.0.1:5173')localStorage.setItem('onboarding/completed','true')})
const samples=[]
const api=async body=>{const response=await fetch(base+'/api/performance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200)}
try {
 await page.goto(base)
 const frame=await page.locator('#stage').elementHandle().then(handle=>handle.contentFrame())
 await frame.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressionGroups.size===44,null,{timeout:60000})
 await page.locator('#performanceState').filter({hasText:'角色已连接'}).waitFor()
 const state=()=>frame.evaluate(()=>{
  const stores=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
  const expressions=stores.get('live2d-expressions')
  let el=document.querySelector('canvas');while(el&&!el.__vueParentComponent)el=el.parentElement
  let scene=el.__vueParentComponent;while(scene&&scene.type.__name!=='Live2D')scene=scene.parent
  const core=scene.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState.model.value.internalModel.coreModel
  return {happy:expressions.expressions.get('ParamCheek76').currentValue,coreHappy:core.getParameterValueById('ParamCheek76'),angry:expressions.expressions.get('ParamCheek80').currentValue,brow:expressions.expressions.get('ParamBrowLY').currentValue,active:stores.get('live2d-motion-control').control.active}
 })
 for(const strength of [0.25,0.7,1]){
  await api({name:'sequence',motion:{label:'笑眼完整切换',frames:[{ms:400,holdMs:1000,pose:{headZ:0.1},expression:{name:'smile',strength}}]}})
  await page.waitForTimeout(650)
  const sample={strength,...await state()};samples.push(sample)
  await frame.locator('canvas').screenshot({path:'data/eye-overlap-'+(captureOnly?'before':'after')+'-'+strength+'.png'})
  if(!captureOnly){assert.equal(sample.happy,1);assert.equal(sample.coreHappy,1)}
  await api({name:'idle'});await page.waitForTimeout(400);assert.equal((await state()).happy,0)
 }
 if(!captureOnly){
  // Every frame of the fade uses a complete replacement, never two half-visible eye styles.
  await api({name:'sequence',motion:{label:'笑眼切回生气',frames:[{ms:500,holdMs:400,pose:{},expression:{name:'smile',strength:0.7}},{ms:500,holdMs:400,pose:{},expression:{name:'pout',strength:0.6}}]}})
  const transition=[]
  for(let i=0;i<14;i++){const sample=await state();transition.push(sample);assert.ok(sample.happy===0||sample.happy===1);assert.ok(!(sample.happy>0&&sample.angry>0));await page.waitForTimeout(100)}
  await api({name:'idle'});await page.waitForTimeout(400);assert.equal((await state()).happy,0);assert.equal((await state()).angry,0)
  assert.ok(transition.some(sample=>sample.happy===1));assert.ok(transition.some(sample=>sample.angry>0))
  assert.notEqual(samples[0].brow,samples[1].brow)
 }
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({pass:!captureOnly,captureOnly,samples,errors}))
}finally{writeFileSync('data/eye-overlap-'+(captureOnly?'before':'after')+'-result.json',JSON.stringify({samples,errors},null,2));await browser.close();app.close();app.closeAllConnections()}