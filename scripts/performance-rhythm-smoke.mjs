import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'

// Real AIRI rendering and playback, isolated settings, synthetic PCM with a deliberate synthesis gap.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const motion={label:'跟着语音轻笑再亮眼',frames:[{ms:500,holdMs:1800,pose:{headZ:0.2},expression:{name:'smile',strength:0.7},components:{tailBase:0.3}},
  {ms:400,holdMs:600,pose:{headZ:-0.1},expression:{name:'星星眼',strength:0.7},components:{tailBase:-0.2}}]}
const pcm=seconds=>{const buffer=Buffer.alloc(22050*2*seconds);for(let n=0;n<buffer.length/2;n++)buffer.writeInt16LE(Math.round(600*Math.sin(2*Math.PI*220*n/22050)),n*2);return buffer.toString('base64')}
const first=pcm(1),second=pcm(3),timers=new Set()
const delay=ms=>new Promise(resolve=>{const timer=setTimeout(()=>{timers.delete(timer);resolve()},ms);timers.add(timer)})
const server=createApp({apiKey:'fixture',token:'',airiOptions:{key:'fixture'},
  reply:async function*(){yield '<act>'+JSON.stringify(motion)+'</act>这是中间留出合成等待的测试语音。'},
  speechOptions:{engine:'index',fetchImpl:async url=>url.endsWith('/health')?Response.json({ok:true,engine:'index-2.5'}):new Response(new ReadableStream({
    async start(controller){
      const send=value=>controller.enqueue(new TextEncoder().encode(JSON.stringify(value)+'\n'))
      // AIRI retains one chunk to mark sentence completion. Two initial chunks expose an actual later gap.
      try{await delay(700);send({type:'audio',pcm:first,sampleRate:22050});send({type:'audio',pcm:first,sampleRate:22050});await delay(3800);send({type:'audio',pcm:second,sampleRate:22050});send({type:'done'});controller.close()}catch{}
    },
  }),{headers:{'Content-Type':'application/x-ndjson'}})},
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']})
const context=await browser.newContext({viewport:{width:1400,height:950},locale:'zh-CN'})
const errors=[]
await context.addInitScript(()=>{localStorage.setItem('onboarding/completed','true');localStorage.setItem('cohost/enabled','true')})
await context.route('http://127.0.0.1:8787/api/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(['/api/status/events','/api/airi/stage/audio/speech'].includes(path))return route.continue({url:base+path})
  await route.fulfill({response:await route.fetch({url:base+path})})
})
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message))
const post=async(path,body)=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.text()}
const status=()=>fetch(base+'/api/status').then(response=>response.json())
async function until(read,accept,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(accept(value))return value;await delay(60)}throw Error('Timed out waiting for performance')}
const state=()=>page.evaluate(()=>{
  const stores=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
  const expressions=stores.get('live2d-expressions'),motion=stores.get('live2d-motion-control')
  return {happy:expressions.expressions.get('ParamCheek76').currentValue,star:expressions.expressions.get('ParamCheek16').currentValue,
    tail:expressions.expressions.get('Param_Angle_Rotation_1_B_tail3').currentValue,
    owner:motion.control.ownerId,axes:motion.control.axes,pose:motion.control.pose,active:motion.control.active}
})
const result={kind:'real browser / real whale / synthetic PCM and model response',errors}
try{
  await page.goto('http://127.0.0.1:5173/?cohost')
  await page.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressions.has('Param_Angle_Rotation_1_B_tail3'),null,{timeout:120000})
  await page.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').setLlmMode('all'))
  const ready=await until(status,state=>state.configuration.performanceCapabilities?.components?.length||state.configuration.components?.length||state.airi.stages.some(stage=>stage.ready))
  const owner=ready.airi.stages.find(stage=>stage.ready).owner
  await post('airi/start',{stage:'web',owner,capture:false})
  await until(status,state=>state.airi.ready)
  await delay(600)
  await post('reply',{source:'host',text:'表演跟随语音测试',voiceOwner:owner})
  await until(state,value=>value.happy===1)
  result.start=await state()
  assert.ok(!result.start.axes.includes('mouthOpen'))
  await delay(1800)
  result.gap=await state()
  assert.equal(result.gap.happy,1,'Synthesis gap retains the current expression')
  assert.equal(result.gap.star,0,'The next expression cannot consume a synthesis gap')
  assert.ok(result.gap.tail>0&&result.gap.tail<13.5,'Long pause softens the continuous component')
  await page.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').toggle('星星眼'))
  await delay(250)
  result.manual=await state();assert.equal(result.manual.star,1);assert.equal(result.manual.happy,0)
  const completed=await until(status,value=>value.room.entries.some(entry=>entry.role==='assistant'&&entry.status==='completed'))
  assert.equal(completed.airi.capture,false)
  await delay(800)
  result.end=await state();assert.equal(result.end.star,1,'Manual selection remains after playback ends');assert.equal(result.end.tail,0);assert.equal(result.end.active,false)
  await page.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').resetAll())
  // The native joystick takes precedence for this command, including after its own release.
  await post('performance',{name:'nod'});await until(state,value=>value.active)
  await page.evaluate(()=>{
    const motion=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-motion-control')
    motion.claimExclusiveControl('qa-operator');motion.setPose('qa-operator',{...motion.control.pose,headX:0.4},{follow:1,inertia:0},['headX'])
  })
  await delay(500);assert.equal((await state()).owner,'qa-operator')
  await page.evaluate(()=>{const motion=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-motion-control');motion.release('qa-operator');motion.releaseExclusiveControl('qa-operator')})
  await delay(400);assert.equal((await state()).active,false)
  await post('performance',{name:'nod'});await until(state,value=>value.active)
  await post('interrupt',{});await until(state,value=>!value.active)
  result.manualPose=true;result.interruption=true
  assert.deepEqual(errors,[]);result.pass=true
  console.log(JSON.stringify({pass:true,gapHold:true,manualFace:true,manualPose:true,completed:true,errors}))
}catch(error){result.error=error.message;result.status=await status();result.state=await state().catch(()=>null);await page.screenshot({path:'data/rhythm-browser-failure.png'}).catch(()=>{});throw error}
finally{writeFileSync('data/rhythm-browser.json',JSON.stringify(result,null,2));await context.unrouteAll({behavior:'ignoreErrors'});await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const timer of timers)clearTimeout(timer)}
