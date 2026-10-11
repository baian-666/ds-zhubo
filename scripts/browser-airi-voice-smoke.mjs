import {once} from 'node:events'
import {readFileSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {streamReply} from '../apps/cohost/deepseek.mjs'
import {createApp} from '../apps/cohost/server.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
// The fake device starts its file immediately. Silence keeps speech after capture setup.
const source=readFileSync(new URL('../data/voice-fixture.wav',import.meta.url))
let format,pcm
for(let offset=12;offset+8<=source.length;){
 const length=source.readUInt32LE(offset+4),id=source.toString('ascii',offset,offset+4)
 if(id==='fmt ')format=source.subarray(offset+8,offset+24)
 if(id==='data')pcm=source.subarray(offset+8,offset+8+length)
 offset+=8+length+(length%2)
}
assert.ok(format && pcm)
assert.equal(format.readUInt16LE(0),1)
const padding=Buffer.alloc(format.readUInt32LE(8)*2)
const header=Buffer.alloc(44)
header.write('RIFF');header.writeUInt32LE(36+padding.length+pcm.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);format.copy(header,20);header.write('data',36);header.writeUInt32LE(padding.length+pcm.length,40)
const voiceFixture=fileURLToPath(new URL('../data/airi-synthetic-input.wav',import.meta.url))
writeFileSync(voiceFixture,Buffer.concat([header,padding,pcm]))
const audio=readFileSync(new URL('../data/siliconflow-voice-trial.wav',import.meta.url))
const real=process.argv.includes('--real')
const freeMotion=process.argv.includes('--free-motion')
const motion={label:'边说边动',frames:[{ms:1200,pose:{eyeX:-0.6,headZ:-0.25},expression:{name:'smile',strength:0.6}},{ms:1200,pose:{eyeX:0.4,headZ:0.3}},{ms:1200,pose:{eyeX:0,headZ:0}}]}
if(real && (!process.env.DEEPSEEK_API_KEY || !process.env.SILICONFLOW_API_KEY))throw Error('Configure local model and speech credentials first')
const calls=[]
const server=createApp({apiKey:real ? process.env.DEEPSEEK_API_KEY : 'test-only',semanticEnabled:real,token:'',rehearsal:true,
  reply:real ? streamReply : async function*(){yield '你好，我听到了。';if(freeMotion)yield '<act:'+JSON.stringify(motion)+'>';await new Promise(r=>setTimeout(r,200));yield '我们继续聊吧。'},
  airiOptions:{key:real ? process.env.SILICONFLOW_API_KEY : 'test-speech-only',fetchImpl:async(url,options)=>{
    calls.push({kind:url.endsWith('speech')?'tts':'asr',at:Date.now()})
    if(real){
      if(url.endsWith('transcriptions'))writeFileSync('data/airi-synthetic-segment.wav',Buffer.from(await options.body.get('file').arrayBuffer()))
      return await fetch(url,options)
    }
    return url.endsWith('transcriptions') ? Response.json({text:'小鲸鱼，你觉得这个故事怎么样？'}) : new Response(audio)
  }}})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+voiceFixture+'%noloop']})
const context=await browser.newContext({viewport:{width:1600,height:1040},permissions:['microphone']})
const page=await context.newPage();page.setDefaultTimeout(60000)
const transport=[]
const consoleLines=[]
const errors=[]
page.on('console', message=>{if(message.type()==='error')consoleLines.push(message.text().slice(0,300))})
page.on('pageerror',e=>errors.push(e.message))
await context.addInitScript(()=>{if(location.origin==='http://127.0.0.1:5173'){localStorage.setItem('onboarding/completed','true');localStorage.setItem('onboarding/skipped','false')}})
await context.route('http://127.0.0.1:8787/api/airi/stage/**',async route=>{
  const request=route.request()
  if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'http://127.0.0.1:5173','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization, Content-Type'}});return}
  const path=new URL(request.url()).pathname
  const headers={...request.headers(),origin:'http://127.0.0.1:5173'}
  delete headers.host;delete headers['content-length']
  const response=await fetch(base+path,{method:request.method(),headers,body:request.postDataBuffer()})
  if(transport.length<10)transport.push({path,status:response.status})
  await route.fulfill({status:response.status,headers:{'Content-Type':response.headers.get('content-type')||'application/json','Access-Control-Allow-Origin':'http://127.0.0.1:5173'},body:Buffer.from(await response.arrayBuffer())})
})
const result={kind:real ? 'Synthetic microphone, real AIRI pipeline and real cloud providers. No human microphone.' : 'AIRI native VAD, transcription adapter and audio playback with synthetic microphone and mocked cloud'}
try {
  await page.goto(base)
  await page.locator('#voiceStage').selectOption('web')
  await page.locator('#voiceStart').waitFor()
  await page.waitForFunction(()=>!document.querySelector('#voiceStart').disabled,null,{timeout:15000})
  await page.locator('#voiceStart').click()
  await page.waitForFunction(()=>document.querySelector('.message.assistant')?.textContent.trim().length>0 || /失败/.test(document.querySelector('#voiceState').textContent),{},{timeout:90000})
  assert.equal(await page.locator('#voiceState').textContent().then(text=>text.includes('失败')),false)
  await page.waitForFunction(()=>document.querySelector('.message.assistant .messageState')?.textContent.includes('播出完成'),{},{timeout:45000})
  result.state=await(await fetch(base+'/api/status')).json()
  assert.equal(result.state.room.entries.filter(e=>e.role==='assistant').length,1)
  assert.equal(result.state.room.entries.find(e=>e.role==='assistant').playedChars,result.state.room.entries.find(e=>e.role==='assistant').text.length)
  assert.ok(calls.some(c=>c.kind==='asr'));assert.ok(calls.some(c=>c.kind==='tts'))
  const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:5173'))
  const module='/@fs/'+fileURLToPath(new URL('../vendor/airi/packages/stage-ui/src/stores/audio.ts',import.meta.url)).replaceAll('\\','/')
  result.model=await frame.evaluate(()=>{const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions');return {id:store.modelId,expressions:store.expressionGroups.size}})
  if(process.argv.includes('--live2d')){assert.ok(result.model.id.startsWith('display-model-'));assert.equal(result.model.expressions,44)}
  result.speaking=await frame.evaluate(async path=>{const {useSpeakingStore}=await import(path);return {speaking:useSpeakingStore().nowSpeaking,mouth:useSpeakingStore().mouthOpenSize}},module)
  if(!real) {
  const second=await fetch(base+'/api/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'host',text:'再说一句，测试停播',voiceOwner:result.state.airi.control})})
  await second.text()
  await page.waitForFunction(()=>document.querySelector('#voiceState').textContent.includes('正在说话'))
  result.freeMotion=freeMotion
  result.mouthDuring=await frame.evaluate(async path=>{
    const {useSpeakingStore}=await import(path)
    let element=document.querySelector('canvas');while(element&&!element.__vueParentComponent)element=element.parentElement
    let scene=element.__vueParentComponent;while(scene&&scene.type.__name!=='Live2D')scene=scene.parent
    const raw=scene.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState
    const core=raw.model.value.internalModel.coreModel
    const samples=[],rendered=[],moving=[]
    for(let i=0;i<20;i++){samples.push(useSpeakingStore().mouthOpenSize);rendered.push(core.getParameterValueById('ParamMouthOpenY'));moving.push(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-motion-control').control.active);await new Promise(r=>setTimeout(r,25))}
    return {max:Math.max(...samples),renderedMax:Math.max(...rendered),speaking:useSpeakingStore().nowSpeaking,simultaneous:rendered.some((value,index)=>value>0 && moving[index])}
  },module)
  assert.equal(result.mouthDuring.speaking,true)
  assert.ok(result.mouthDuring.max>0,'actual audio must drive lip sync')
  assert.ok(result.mouthDuring.renderedMax>0,'the loaded model mouth must move')
  if(freeMotion)assert.equal(result.mouthDuring.simultaneous,true,'free body movement and audio lip sync must coexist')
  const interruptedAt=Date.now()
  await page.locator('#interrupt').click()
  await frame.waitForFunction(async path=>!(await import(path)).useSpeakingStore().nowSpeaking,module,{timeout:3000})
  result.buttonStopMs=Date.now()-interruptedAt
  assert.ok(result.buttonStopMs<1000)
  await page.waitForTimeout(450)
  result.afterStop=await frame.evaluate(async path=>{const {useSpeakingStore}=await import(path);return {speaking:useSpeakingStore().nowSpeaking,mouth:useSpeakingStore().mouthOpenSize}},module)
  assert.equal(result.afterStop.speaking,false)
  assert.equal(result.afterStop.mouth,0)
  }
  await page.locator('#voiceStop').click()
  await page.waitForFunction(()=>document.querySelector('#voiceState').textContent.includes('点击开始'))
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.deepEqual(errors,[])
  result.pass=true
  await page.screenshot({path:real ? 'data/airi-voice-real.png' : 'data/airi-voice-browser.png',fullPage:true})
} catch(error) {
  result.pass=false;result.error=error.message;result.state=await(await fetch(base+'/api/status')).json()
  await page.screenshot({path:real ? 'data/airi-voice-real-failure.png' : 'data/airi-voice-browser-failure.png',fullPage:true})
  process.exitCode=1
} finally {
  result.errors=errors;result.calls=calls;result.transport=transport;result.consoleLines=consoleLines
  writeFileSync(real ? 'data/airi-voice-real-result.json' : 'data/airi-voice-browser-result.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify({pass:result.pass,error:result.error,errors,calls,transport,consoleLines:consoleLines.slice(0,8),voice:result.state?.airi,entries:result.state?.room.entries.filter(e=>e.role==='host'||e.role==='assistant')}))
  await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))
}
