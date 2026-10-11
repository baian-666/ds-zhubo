import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
import {streamReply} from '../apps/cohost/deepseek.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const real=process.argv.includes('--real')
if(real&&!process.env.DEEPSEEK_API_KEY)throw Error('Configure the local model credential first')
const fixture={label:'侧目再轻笑',frames:[
 {ms:1200,pose:{eyeX:-0.65,headZ:-0.25},expression:{name:'smile',strength:0.7}},
 {ms:1200,pose:{eyeX:0.4,headZ:0.3,bodyZ:0.15,mouthForm:0.5},expression:{name:'pout',strength:0.6}},
 {ms:800,pose:{eyeX:0,headZ:0,bodyZ:0,mouthForm:0.1},expression:{name:'smile',strength:0.5}},
]}
let modelCalls=0,modelOutput=""
const server=createApp({apiKey:real?process.env.DEEPSEEK_API_KEY:'test-only',token:'',reply:async function*(options){
 modelCalls++
 if(real){for await(const chunk of streamReply(options)){modelOutput+=chunk;yield chunk}return}
 yield '我才没有摸鱼呢。';yield '<act:'+JSON.stringify(fixture)+'>';yield '这是战略思考。'
}})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1500,height:1100}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(()=>{if(location.origin==='http://127.0.0.1:5173')localStorage.setItem('onboarding/completed','true')})
const post=(name,body)=>fetch(base+'/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
const status=()=>fetch(base+'/api/status').then(r=>r.json())
const result={kind:real?'real DeepSeek + actual AIRI model':'fixture response + actual AIRI model',samples:[]}
try {
 await page.goto(base)
 const frame=await page.locator('#stage').elementHandle().then(h=>h.contentFrame())
 await frame.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressionGroups.size===44,null,{timeout:60000})
 await page.locator('#performanceState').filter({hasText:'角色已连接'}).waitFor()
 async function state(){
  return await frame.evaluate(()=>{
   const stores=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
   const motion=stores.get('live2d-motion-control'),expressions=stores.get('live2d-expressions')
   let el=document.querySelector('canvas');while(el&&!el.__vueParentComponent)el=el.parentElement
   let scene=el.__vueParentComponent;while(scene&&scene.type.__name!=='Live2D')scene=scene.parent
   const core=scene.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState.model.value.internalModel.coreModel
   return {at:Date.now(),active:motion.control.active,pose:JSON.parse(JSON.stringify(motion.control.pose)),
    happy:expressions.expressions.get('ParamCheek76').currentValue,angry:expressions.expressions.get('ParamCheek80').currentValue,
    core:{eyeX:core.getParameterValueById('ParamEyeBallX'),headZ:core.getParameterValueById('ParamAngleZ'),mouth:core.getParameterValueById('ParamMouthOpenY')}}
  })
 }
 const request=post('reply',{source:'host',text:'小鲸鱼，你是不是又在摸鱼，被我抓到了吧！你一边解释一边自己安排几个连贯的小动作给我看看。'})
 await frame.waitForFunction(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-motion-control').control.active,null,{timeout:30000})
 // The generic thinking pose can precede the plan. Wait for the actual sequence receipt.
 await page.locator('#performanceState').filter({hasText:'第 '}).waitFor({timeout:30000})
 result.motion=(await status()).performance.motion
 assert.ok(result.motion)
 for(let i=0;i<8;i++){result.samples.push(await state());if(i===1||i===5)await page.screenshot({path:'data/free-motion-'+(real?'real':'mock')+'-'+i+'.png',fullPage:true});await page.waitForTimeout(180)}
 const reply=await(await request).text()
 assert.ok(!reply.includes('<act:'));assert.ok(!reply.includes('"frames"'))
 assert.equal(modelCalls,1)
 const active=result.samples.filter(x=>x.active)
 assert.ok(active.length>=2)
 assert.ok(active.some((sample,i)=>i>0&&(Math.abs(sample.core.eyeX-active[0].core.eyeX)>0.005||Math.abs(sample.core.headZ-active[0].core.headZ)>0.005)),'actual Cubism parameters must change')
 result.answer=(await status()).room.entries.find(e=>e.role==='assistant').text
 await post('interrupt',{})
 await page.waitForTimeout(650)
 assert.equal((await state()).active,false)
 // An operator edit during continuous expression updates must survive subsequent ticks and release.
 await post('performance',{name:'sequence',motion:{label:'人工接管检查',frames:[{ms:1800,pose:{eyeX:0.3},expression:{name:'smile',strength:0.8}},{ms:1800,pose:{eyeX:0.3}}]}})
 await frame.waitForFunction(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').expressions.get('ParamCheek76').currentValue>0.05)
 await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').set('ParamCheek76',0.25))
 await page.waitForTimeout(350);assert.equal((await state()).happy,0.25)
 await post('interrupt',{});await page.waitForTimeout(500);assert.equal((await state()).happy,0.25)
 await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').set('ParamCheek76',0))
 await post('performance',{name:'sequence',motion:fixture})
 await page.waitForTimeout(700)
 await page.route('**/api/status',route=>route.abort())
 await page.waitForTimeout(1800)
 assert.equal((await state()).active,false)
 assert.equal((await state()).happy,0)
 assert.equal((await state()).angry,0)
 assert.deepEqual(errors,[])
 result.pass=true;result.modelCalls=modelCalls;result.modelOutput=modelOutput;result.errors=errors
 console.log(JSON.stringify({pass:true,kind:result.kind,modelCalls,motion:result.motion,answer:result.answer,errors}))
}catch(error){result.pass=false;result.error=error.message;result.modelOutput=modelOutput;result.state=await status();await page.screenshot({path:'data/free-motion-failure.png',fullPage:true});throw error}
finally{
 writeFileSync('data/free-motion-'+(real?'real':'mock')+'-result.json',JSON.stringify(result,null,2))
 await browser.close();server.close();server.closeAllConnections()
}
