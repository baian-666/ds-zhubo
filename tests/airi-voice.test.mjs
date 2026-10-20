import {testCapabilities} from './fixtures/performance.mjs'
import {streamParticipation} from '../apps/cohost/participation-stream.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { AiriVoice } from '../apps/cohost/airi-voice.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { createApp } from '../apps/cohost/server.mjs'
import { streamQwenAudio, AUDIO_MODEL } from '../scripts/qwen-audio-client.mjs'

test('local streaming capture needs no cloud key and releases its worker when capture stops',async()=>{
  let prepared=0,cleared=0,opened=0
  const adapter={available:()=>true,async prepare(){prepared++},clear(){cleared++},
    open(){opened++;return {done:new Promise(()=>{}),close(){}}}}
  const voice=new AiriVoice({key:'',realtimeKey:'',localRecognitionAdapter:adapter,recognition:()=>({provider:'local',model:'sherpa-zipformer-zh'})})
  voice.pulse({stage:'web',owner:'renderer',ready:true})
  voice.start('web','controller',true)
  const state=voice.pulse({stage:'web',owner:'renderer',ready:true})
  assert.equal(state.recognition,'local');assert.equal(voice.recognitionReady(),true)
  await voice.prepareRecognition(state.captureRevision)
  voice.openRecognition(1,state.captureRevision,()=>{})
  assert.equal(prepared,1);assert.equal(opened,1)
  voice.stop()
  assert.ok(cleared>=1);assert.equal(voice.segments.size,0)
  assert.throws(()=>voice.openRecognition(2,state.captureRevision,()=>{}),/失效/)
})

test('playback-only lease works with microphone off and cannot transcribe', async () => {
  const voice=new AiriVoice({key:''})
  voice.pulse({stage:'web',owner:'stage-owner',ready:true,listening:false})
  assert.equal(voice.start('web','panel-owner',false).capture,false)
  const state=voice.pulse({stage:'web',owner:'stage-owner',ready:true,listening:false})
  assert.ok(state.run)
  assert.equal(state.capture,false)
  assert.equal(voice.snapshot().ready,true)
  await assert.rejects(voice.cloud('transcriptions',new FormData()),/麦克风未开启/)
  assert.throws(()=>voice.start('web','other-owner',false),/已有舞台/)
  voice.key='fixture'
  assert.equal(voice.start('web','panel-owner',true).capture,true)
  assert.equal(voice.pulse({stage:'web',owner:'stage-owner',ready:true,listening:false}).run,state.run)
  voice.stop()
})

test('AIRI lease has one stage owner and closes without restarting on lost heartbeat', () => {
  let now=100, stopped=0
  const voice=new AiriVoice({key:'private-test-key',now:()=>now,onStop:()=>stopped++})
  assert.throws(()=>voice.start('web','console'),/尚未连接/)
  voice.pulse({stage:'web',owner:'first-owner',ready:true,listening:true})
  voice.start('web','console')
  assert.equal(voice.pulse({stage:'desktop',owner:'second-owner',ready:true,listening:true}).run,null)
  const run=voice.pulse({stage:'web',owner:'first-owner',ready:true,listening:true}).run
  assert.ok(run)
  assert.equal(voice.pulse({stage:'web',owner:'second-owner',ready:true,listening:true}).run,null)
  assert.throws(()=>voice.authenticate({headers:{authorization:'Bearer '+run+':second-owner'}}),/失效/)
  assert.equal(JSON.stringify(voice.snapshot()).includes('private-test-key'),false)
  now+=3501;voice.tick()
  assert.equal(stopped,1);assert.equal(voice.snapshot().active,false)
  assert.equal(voice.pulse({stage:'web',owner:'first-owner',ready:true,listening:true}).run,null)
})

test('microphone changes preserve the playback lease and cancel only pending recognition',async()=>{
 let finishAsr,asrSignal,speechSignal,stopped=0
 const voice=new AiriVoice({key:'fixture',onStop:()=>stopped++,fetchImpl:async(url,{signal})=>{
   if(url.endsWith('transcriptions')) {asrSignal=signal;await new Promise(r=>finishAsr=r);return Response.json({text:'旧收音结果'})}
   speechSignal=signal;const bytes=Buffer.alloc(44);bytes.write('RIFF');return new Response(bytes)
 }})
 voice.pulse({stage:'desktop',owner:'stage-owner',ready:true})
 voice.start('desktop','controller',true)
 const run=voice.session.id,revision=voice.session.captureRevision
 const recognition=voice.cloud('transcriptions',new FormData())
 await voice.cloud('speech','{}')
 assert.throws(()=>voice.setCapture('other-controller',false),/当前舞台/)
 voice.setCapture('controller',false)
 assert.equal(asrSignal.aborted,true);assert.equal(speechSignal.aborted,false)
 assert.equal(voice.session.id,run);assert.equal(voice.snapshot().ready,true);assert.equal(stopped,0)
 voice.setCapture('controller',true)
 assert.equal(voice.acceptsCapture(revision),false)
 assert.equal(voice.acceptsCapture(voice.session.captureRevision),true)
 finishAsr();await assert.rejects(recognition,/过期/);assert.equal(voice.lastText,'')
})

test('capture controls during playback preserve output and reject events from an old capture generation',async t=>{
 const app=await setup(t)
 await (await app.post('/api/reply',{source:'host',text:'小鲸鱼，继续',voiceOwner:'console-owner'})).text()
 const before=await (await app.pulse()).json()
 const playback={type:'playback',turn:before.turn.id,audioId:before.turn.audioId}
 await app.event({...playback,event:'started',playedChars:0})
 await app.event({...playback,event:'progress',playedChars:3})
 await app.event({type:'speech-start',utterance:123})
 const changed=await app.post('/api/airi/capture',{owner:'console-owner',capture:false})
 assert.equal(changed.status,200)
 let state=await (await app.pulse()).json()
 assert.equal(state.run,before.run);assert.equal(state.turn.id,before.turn.id)
 assert.equal((await (await fetch(app.url+'/api/status')).json()).hostSpeaking,false)
 await app.post('/api/airi/capture',{owner:'console-owner',capture:true})
 state=await (await app.pulse()).json()
 assert.equal((await (await app.event({type:'transcript',utterance:123,text:'迟到的旧文字',final:true})).json()).accepted,false)
 assert.equal((await (await app.event({type:'capture-error',captureRevision:before.captureRevision})).json()).accepted,false)
 assert.equal((await (await app.event({type:'capture-error',captureRevision:state.captureRevision})).json()).accepted,true)
 assert.equal((await (await app.event({...playback,event:'ended',playedChars:7})).json()).accepted,true)
 const status=await (await fetch(app.url+'/api/status')).json()
 assert.equal(status.airi.active,true);assert.equal(status.airi.capture,false)
 assert.equal(status.room.entries.findLast(x=>x.role==='assistant').status,'completed')
 assert.equal(status.room.entries.some(x=>x.text==='迟到的旧文字'),false)
})

test('stopping a lease aborts cloud transport and discards a provider that returns late', async () => {
  let release, sent
  const voice=new AiriVoice({key:'private-test-key',fetchImpl:async (url,options)=>{
    sent={url,options};await new Promise(r=>release=r);return Response.json({text:'不能复活'})
  }})
  voice.pulse({stage:'web',owner:'first-owner',ready:true,listening:true});voice.start('web','console')
  voice.pulse({stage:'web',owner:'first-owner',ready:true,listening:true})
  const promise=voice.cloud('transcriptions',new FormData())
  assert.equal(sent.url,'https://api.siliconflow.cn/v1/audio/transcriptions')
  voice.stop();assert.equal(sent.options.signal.aborted,true)
  release()
  await assert.rejects(promise,/过期/)
  assert.equal(voice.lastText,'')
})

test('provider failures are sanitized and request abort cancels synthesis', async () => {
  const voice=new AiriVoice({key:'private-test-key',fetchImpl:async()=>new Response('private-test-key provider body',{status:402})})
  voice.pulse({stage:'web',owner:'first-owner',ready:true,listening:true});voice.start('web','console')
  voice.pulse({stage:'web',owner:'first-owner',ready:true,listening:true})
  await assert.rejects(voice.cloud('speech','{}'),e=>e.status===502&&!e.message.includes('private-test-key'))
  let captured
  voice.fetch=async (url,{signal})=>{captured=signal;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw Error('private-test-key')}
  const abort=new AbortController()
  const promise=voice.cloud('speech','{}',{turnSignal:abort.signal})
  abort.abort()
  await assert.rejects(promise,e=>e.status===409)
  assert.equal(captured.aborted,true)
})

async function setup(t,options={}) {
  const server=createApp({apiKey:'test-key',token:'',rehearsal:true,observer:async()=>({choice:'consider_speaking',reason:'有新的内容方向。',idea:'继续展开话题。'}),airiOptions:{key:'speech-private'},reply:async function*(){yield '你好。';yield '继续聊。'},...options})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})
  const url='http://127.0.0.1:'+server.address().port
  const post=(path,body,headers={})=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  const pulse=()=>post('/api/airi/stage/pulse',{captureRevision:1,stage:'web',owner:'stage-owner',ready:true,listening:!options.playbackOnly},{Origin:'http://127.0.0.1:5173'})
  await pulse()
  assert.equal((await post('/api/airi/start',{stage:'web',owner:'console-owner',capture:!options.playbackOnly})).status,200)
  const session=await(await pulse()).json()
  const headers={Origin:'http://127.0.0.1:5173',Authorization:'Bearer '+session.run+':stage-owner','X-Cohost-Capture':String(session.captureRevision)}
  return {url,post,pulse,headers,event:body=>post('/api/airi/stage/event',{captureRevision:session.captureRevision,...body},headers)}
}
async function until(read,accept) {
  const end=Date.now()+3000
  while(Date.now()<end){const value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,20))}
  throw Error('Timed out')
}

test('floor events own the capture and output, and cannot revive a cancelled answer',async t=>{
  const app=await setup(t)
  await(await app.post('/api/reply',{source:'host',text:'你好',voiceOwner:'console-owner'})).text()
  const {turn}=await(await app.pulse()).json()
  await app.event({type:'speech-start',utterance:1})
  const event={type:'floor',turn:turn.id,audioId:turn.audioId,utterance:1,state:'hold'}
  assert.equal((await(await app.event({...event,utterance:2})).json()).accepted,false)
  assert.equal((await(await app.event({...event,captureRevision:0})).json()).accepted,false)
  assert.equal((await(await app.event({...event,turn:turn.id+1})).json()).accepted,false)
  assert.equal((await(await app.event(event)).json()).accepted,true)
  assert.equal((await(await app.pulse()).json()).turn.id,turn.id)
  assert.equal((await(await app.event({...event,state:'yield'})).json()).accepted,true)
  assert.equal((await(await app.event({...event,state:'play'})).json()).accepted,false)
  assert.equal((await(await app.pulse()).json()).turn,null)
})

test('HTTP delivers a streamed reply before applying its final audience handoff',async t=>{
 let calls=0
 const records=[{kind:'decision',action:'reply_program',hostIntent:'spontaneous',reason:'展开话题。',text:'我先举个例子。',targetId:'',platform:'',hostingPace:'continue',revisitAfterSeconds:3},
   {kind:'speech',text:'你们遇到过吗？我先听大家说。'},
   {kind:'closing',handoff:'audience',revisitAfterSeconds:30,reason:'这次把问题交给观众。'}]
 const app=await setup(t,{playbackOnly:true,semanticEnabled:true,planner:(snapshot,options)=>{
   calls++
   const events=[{choices:[{index:0,delta:{tool_calls:[{index:0,id:'test',type:'function',function:{name:'participate',arguments:JSON.stringify({records})}}]},finish_reason:null}]},
     {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}]
   return streamParticipation(snapshot,{...options,fetchImpl:async()=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n')})
 }})
 const initial=await(await fetch(app.url+'/api/status')).json()
 assert.equal((await app.post('/api/hosting',{action:'start',topic:'',owner:'console-owner',revision:initial.hosting.revision})).status,200)
 const current=await until(async()=>(await app.pulse()).json(),s=>s.turn?.done)
 let state=await(await fetch(app.url+'/api/status')).json()
 assert.equal(state.hosting.nextReviewAt,null);assert.equal(calls,1)
 const event={type:'playback',turn:current.turn.id,audioId:current.turn.audioId}
 assert.equal((await(await app.event({...event,event:'started',playedChars:0})).json()).accepted,true)
 assert.equal((await(await app.event({...event,event:'ended',playedChars:current.turn.text.length})).json()).accepted,true)
 state=await until(async()=>(await fetch(app.url+'/api/status')).json(),s=>s.hosting.state==='waiting')
 assert.equal(state.hosting.lastHandoff,'audience');assert.equal(state.hosting.pace,'yield')
 assert.equal(state.hosting.nextReviewAt,null);assert.equal(calls,1)
})

test('the live continuous observer refreshes time while waiting without generating speech',async t=>{
 const seen=[]
 const app=await setup(t,{playbackOnly:true,semanticEnabled:true,participationOptions:{debounceMs:1},planner:async()=>assert.fail('no speech requested'),observer:async snapshot=>{
   seen.push(snapshot)
   return {choice:'wait',reason:'此刻继续安静。',idea:''}
 }})
 const pulse=setInterval(()=>{void app.pulse()},1000)
 t.after(()=>clearInterval(pulse))
 const initial=await(await fetch(app.url+'/api/status')).json()
 assert.equal((await app.post('/api/hosting',{action:'start',topic:'日常小发现',owner:'console-owner',revision:initial.hosting.revision})).status,200)
 await until(async()=>seen.length,count=>count===1)
 const deadline=Date.now()+5000
 while(seen.length<3 && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50))
 assert.equal(seen.length,3)
 const second=seen[1]
 assert.equal(second.hostOpportunity,false);assert.equal(second.latestHost,null);assert.deepEqual(second.eligibleViewers,[])
 assert.equal(second.programOpportunity,false);assert.equal(second.hosting.wakeup,null)
 assert.ok(second.clock.nowMs-seen[0].clock.nowMs>=1000)
 assert.equal(second.hosting.observation.choice,'wait')
 assert.equal(second.hosting.nextReviewAt,null)
 assert.equal(second.clock.iso,new Date(second.clock.nowMs).toISOString())
 const current=await(await fetch(app.url+'/api/status')).json()
 assert.equal((await app.post('/api/hosting',{action:'pause',revision:current.hosting.revision})).status,200)
 const paused=await(await fetch(app.url+'/api/status')).json()
 assert.equal(paused.hosting.nextReviewAt,null);assert.equal(paused.room.entries.some(entry=>entry.role==='host'),false)
})

test('hosting HTTP queues ordinary chat with accurate feedback and uses the same selection at execution',async t=>{
  const seen=[]
  const app=await setup(t,{playbackOnly:true,semanticEnabled:true,planner:async snapshot=>{
    seen.push(snapshot)
    const item=snapshot.eligibleViewers[0]
    return item ? {action:'reply_viewer',hostIntent:'none',reason:'观众在问现场情况，我来接一句。',text:'我在呀，正等你一起聊呢。',targetId:item.id,platform:item.platform}
      : {action:'wait',hostIntent:'none',reason:'先等大家说话。',text:'',targetId:'',platform:''}
  }})
  const response=await app.post('/api/danmaku',{platform:'manual',id:'ordinary',userId:'viewer',text:'怎么好像就你一个人啊'})
  const body=await response.json();assert.equal(body.accepted,true)
  const explanation=body.room.entries.at(-1)
  assert.equal(explanation.reason,'viewer_pending');assert.match(explanation.explanation,/待选/);assert.doesNotMatch(explanation.explanation,/冷却/)
  const queued=await(await fetch(app.url+'/api/status')).json()
  assert.ok(queued.queue[0].expiresAt-Date.now()>80000)
  const current=await until(async()=>(await app.pulse()).json(),s=>s.turn?.done)
  assert.equal(current.turn.text,'我在呀，正等你一起聊呢。')
  assert.equal(seen[0].eligibleViewers[0].id,'ordinary')
  const busy=await(await app.post('/api/danmaku',{platform:'manual',id:'during',userId:'viewer',text:'主播呢'})).json()
  assert.equal(busy.room.entries.at(-1).reason,'viewer_busy');assert.match(busy.room.entries.at(-1).explanation,/讲完后/)
  assert.equal((await(await app.post('/api/danmaku',{platform:'manual',id:'repeat',userId:'viewer',text:'主播呢'})).json()).accepted,false)
})

test('hosting API owns one run, preserves voice, and explicit host stop blocks automatic restart',async t=>{
  let calls=0
  const app=await setup(t,{playbackOnly:true,semanticEnabled:true,planner:async()=>{
    calls++;return {action:'reply_program',hostIntent:'spontaneous',reason:'我来开一个海底商店话题。',text:'今天开一家海底商店，卖什么好？',targetId:'',platform:''}
  }})
  const get=async path=>(await fetch(app.url+path)).json()
  const before=await get('/api/speech/config')
  const initial=await get('/api/status')
  assert.equal(initial.hosting.state,'observing')
  assert.equal((await app.post('/api/hosting',{action:'start',topic:'海底商店',owner:'wrong',revision:0})).status,409)
  assert.equal((await app.post('/api/hosting',{action:'start',topic:'海底商店',owner:'console-owner',revision:initial.hosting.revision})).status,200)
  const current=await until(async()=>(await app.pulse()).json(),s=>s.turn?.done)
  assert.equal(current.capture,false);assert.equal(calls,1)
  const {turn}=current
  await app.event({type:'playback',event:'started',turn:turn.id,audioId:turn.audioId,playedChars:0})
  for(const event of [{type:'speech-start',utterance:1},{type:'transcript',utterance:1,text:'停停停，先打住。',final:true},{type:'speech-end',utterance:1}])await app.post('/api/director/event',event)
  let status=await get('/api/status')
  assert.equal(status.hosting.state,'paused');assert.equal(status.hosting.reason,'stop');assert.equal(status.hosting.steps,0)
  assert.equal((await app.post('/api/hosting',{action:'resume',owner:'console-owner',revision:0})).status,409)
  await app.post('/api/danmaku',{platform:'manual',id:'1',userId:'viewer',text:'继续呀',mentioned:true})
  status=await get('/api/status');assert.equal(status.hosting.state,'paused');assert.equal(calls,1)
  assert.equal((await app.post('/api/hosting',{action:'stop',revision:status.hosting.revision})).status,200)
  assert.equal((await get('/api/status')).hosting.state,'off')
  assert.deepEqual((await get('/api/speech/config')).effective,before.effective)
  assert.equal((await app.event({type:'playback',event:'ended',turn:turn.id,audioId:turn.audioId,playedChars:turn.text.length})).status,200)
  assert.equal((await get('/api/status')).hosting.steps,0)
})

test('typed host input reaches Index playback with microphone off', async t => {
  const app=await setup(t,{playbackOnly:true,speechOptions:{engine:'index',fetchImpl:async url=>
    url.endsWith('/health')?Response.json({ok:true,engine:'index-2.5'}):new Response(
      JSON.stringify({type:'audio',sampleRate:22050,pcm:Buffer.alloc(4410).toString('base64')})+'\n'+JSON.stringify({type:'done',firstPcmMs:10,totalMs:20})+'\n')}})
  for(const event of [{type:'speech-start',utterance:42},{type:'transcript',utterance:42,text:'小鲸鱼，你觉得今天怎么样？',final:true},{type:'speech-end',utterance:42}])
    assert.equal((await app.post('/api/director/event',event)).status,200)
  const state=await until(async()=>(await app.pulse()).json(),x=>x.turn?.done)
  assert.equal(state.capture,false)
  const response=await app.post('/api/airi/stage/audio/speech',{turn:state.turn.id,input:'你好。'},app.headers)
  assert.equal(response.status,200)
  assert.match(await response.text(),/"sampleRate":22050/)
})

test('hosting controls tolerate runtime revisions but do not cross a later manual pause',async t=>{
 const app=await setup(t,{playbackOnly:true,semanticEnabled:true,planner:async()=>({action:'wait',hostIntent:'none',reason:'留白。',text:'',targetId:'',platform:''})})
 const get=async()=>(await fetch(app.url+'/api/status')).json()
 const initial=await get()
 for(const event of [{type:'speech-start',utterance:1},{type:'transcript',utterance:1,text:'今天聊海洋',final:true},{type:'speech-end',utterance:1}])await app.post('/api/director/event',event)
 assert.ok((await get()).hosting.revision>initial.hosting.revision)
 assert.equal((await app.post('/api/hosting',{action:'pause',revision:initial.hosting.revision})).status,200)
 assert.equal((await app.post('/api/hosting',{action:'resume',owner:'console-owner',revision:initial.hosting.revision})).status,409)
 const paused=await get()
 assert.equal((await app.post('/api/hosting',{action:'resume',owner:'console-owner',revision:paused.hosting.revision})).status,200)
})

test('final host delegation restores hosting through HTTP without changing the microphone or voice',async t=>{
 const app=await setup(t,{playbackOnly:true,semanticEnabled:true,planner:async snapshot=>({action:'wait',hostIntent:'none',reason:'接手主持。',text:'',targetId:'',platform:'',
   hostingControl:snapshot.hostOpportunity?'start':undefined})})
 const get=async()=>(await fetch(app.url+'/api/status')).json()
 const initial=await get()
 await app.post('/api/hosting',{action:'stop',revision:initial.hosting.revision})
 for(const event of [{type:'speech-start',utterance:1},{type:'transcript',utterance:1,text:'你先播着，我去忙点别的',final:true},{type:'speech-end',utterance:1}])await app.post('/api/director/event',event)
 const state=await until(get,s=>s.hosting.state==='waiting')
 assert.equal(state.hosting.reason,'observing');assert.equal(state.hosting.automatic,true);assert.equal(state.hosting.continuous,true)
 assert.equal(state.hosting.nextReviewAt,null);assert.equal(state.airi.capture,false)
 assert.deepEqual(state.configuration,initial.configuration)
})

test('Index first audio delayed beyond 15 seconds still plays; true timeouts are failures', async t => {
  let now=0, release
  const scheduler=new Scheduler({now:()=>now})
  const app=await setup(t,{playbackOnly:true,scheduler,speechOptions:{engine:'index',fetchImpl:async url=>{
    if(url.endsWith('/health'))return Response.json({ok:true,engine:'index-2.5'})
    await new Promise(resolve=>{release=resolve})
    return new Response(JSON.stringify({type:'audio',sampleRate:22050,pcm:Buffer.alloc(4410).toString('base64')})+'\n'+JSON.stringify({type:'done'})+'\n')
  }}})
  for(const timeout of [false,true]) {
    await (await app.post('/api/reply',{source:'host',text:'可以唱首歌吗',voiceOwner:'console-owner'})).text()
    const state=await (await app.pulse()).json()
    release=undefined
    const response=await app.post('/api/airi/stage/audio/speech',{turn:state.turn.id,input:'你好。'},app.headers)
    await until(()=>release,Boolean)
    now+=timeout?60000:20000
    assert.equal(scheduler.status().busy,!timeout)
    release();await response.text()
    if(!timeout) {
      const body={type:'playback',turn:state.turn.id,audioId:state.turn.audioId}
      assert.equal((await (await app.event({...body,event:'started',playedChars:0})).json()).accepted,true)
      assert.equal((await (await app.event({...body,event:'ended',playedChars:state.turn.text.length})).json()).accepted,true)
    }
    const status=await (await fetch(app.url+'/api/status')).json()
    const answer=status.room.entries.findLast(x=>x.role==='assistant')
    assert.equal(answer.status,timeout?'failed':'completed')
    assert.equal(answer.playedChars,timeout?0:state.turn.text.length)
    if(timeout)assert.equal(answer.errorCode,'speech_playback_failed')
  }
})

test('speech endpoint uses the current turn style rather than a client supplied override', async t => {
  const sent=[]
  const app=await setup(t,{playbackOnly:true,reply:async function*(){yield '<voice:gentle>你好。'},speechOptions:{engine:'index',fetchImpl:async(url,options)=>{
    if(url.endsWith('/health'))return Response.json({ok:true,engine:'index-2.5'})
    sent.push(JSON.parse(options.body))
    return new Response(JSON.stringify({type:'audio',sampleRate:22050,pcm:Buffer.alloc(4410).toString('base64')})+'\n'+JSON.stringify({type:'done'})+'\n')
  }}})
  await (await app.post('/api/reply',{source:'host',text:'今天有点难过',voiceOwner:'console-owner'})).text()
  const state=await (await app.pulse()).json()
  assert.equal(state.turn.text,'你好。')
  const response=await app.post('/api/airi/stage/audio/speech',{turn:state.turn.id,input:'你好。',style:'happy',speechStyle:'happy'},app.headers)
  assert.equal(response.status,200);await response.text()
  assert.deepEqual(sent,[{text:'你好。',style:'gentle'}])
})

test('Qwen speech stays instruction-free across director styles, sentences and client overrides', async t => {
  for (const style of ['happy', 'neutral', undefined]) {
    const requests=[]
    class Socket extends EventTarget {
      constructor() {super();this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))})}
      close() {this.readyState=3}
      send(value) {
        const event=JSON.parse(value),taskId=event.header.task_id
        const emit=name=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({header:{event:name,task_id:taskId}})}))
        if(event.header.action==='run-task') {
          this.parameters=event.payload.parameters
          queueMicrotask(()=>emit('task-started'))
        }
        if(event.header.action==='continue-task')requests.push(this.parameters)
        if(event.header.action==='finish-task')queueMicrotask(()=>{
          if(event.payload.input.directive!=='cancel')this.dispatchEvent(new MessageEvent('message',{data:new Int16Array(2400).fill(1000).buffer}))
          emit('task-finished')
        })
      }
    }
    let modelCalls=0
    const voice=AUDIO_MODEL+'-fixture-'+'a'.repeat(32)
    const records=[{kind:'decision',action:'reply_program',hostIntent:'spontaneous',reason:'自然接着聊。',text:'今天来聊一聊。',targetId:'',platform:'',speechStyle:style},
      {kind:'speech',text:'你想先聊什么？',speechStyle:'surprised'},
      {kind:'closing',handoff:'listen',revisitAfterSeconds:0,reason:'等搭档说话。'}]
    const app=await setup(t,{playbackOnly:true,semanticEnabled:true,
      speechOptions:{engine:'qwen',voice:'克隆音色',qwenKey:'sk-fixture-not-a-real-key',qwenClone:{model:AUDIO_MODEL,voice},qwen:options=>streamQwenAudio({...options,WebSocketImpl:Socket})},
      planner:(snapshot,options)=>{
        modelCalls++
        const data={choices:[{index:0,delta:{tool_calls:[{index:0,id:'test',type:'function',function:{name:'participate',arguments:JSON.stringify({records})}}]},finish_reason:null}]}
        const finish={choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}
        return streamParticipation(snapshot,{...options,fetchImpl:async()=>new Response('data: '+JSON.stringify(data)+'\n\ndata: '+JSON.stringify(finish)+'\n\ndata: [DONE]\n\n')})
      }})
    const initial=await(await fetch(app.url+'/api/status')).json()
    await app.post('/api/hosting',{action:'start',topic:'',owner:'console-owner',revision:initial.hosting.revision})
    const current=await until(async()=>(await app.pulse()).json(),s=>s.turn?.done)
    for(const input of ['今天来聊一聊。','你想先聊什么？']) {
      const response=await app.post('/api/airi/stage/audio/speech',{turn:current.turn.id,input,speechStyle:'gentle'},app.headers)
      assert.equal(response.status,200);assert.ok((await response.text()).includes('"type":"audio"'))
    }
    assert.equal(modelCalls,1)
    assert.equal(requests.length,2)
    for(const request of requests) {
      assert.equal(Object.hasOwn(request,'instruction'),false)
      assert.equal(request.voice,voice);assert.equal(request.seed,0)
    }
    await app.event({type:'playback',turn:current.turn.id,audioId:current.turn.audioId,event:'ended',playedChars:current.turn.text.length})
  }
})

test('playback failure is distinct from an interruption and only played text enters history', async t => {
  const seen=[]
  const app=await setup(t,{playbackOnly:true,reply:async function*(options){seen.push(options.history);yield '你好。继续聊。'}})
  for(const event of ['error','stopped']) {
    await (await app.post('/api/reply',{source:'host',text:'小鲸鱼，继续聊吧',voiceOwner:'console-owner'})).text()
    const state=await (await app.pulse()).json()
    const body={type:'playback',turn:state.turn.id,audioId:state.turn.audioId}
    assert.equal((await (await app.event({...body,event:'started',playedChars:0})).json()).accepted,true)
    await app.event({...body,event:'progress',playedChars:3})
    assert.equal((await (await app.event({...body,event,playedChars:3})).json()).accepted,true)
    const status=await (await fetch(app.url+'/api/status')).json()
    const answer=status.room.entries.findLast(entry=>entry.role==='assistant')
    assert.equal(answer.status,event==='error'?'failed':'cancelled')
    assert.equal(answer.errorCode,event==='error'?'speech_playback_failed':undefined)
    assert.equal(answer.playedChars,3)
    assert.equal(status.busy,false)
  }
  assert.equal(seen[1].at(-1).content,'你好。')
})

test('confirmed host stop cancels Qwen synthesis and playback while retaining capture and voice settings',async t=>{
  let synthesisSignal
  const app=await setup(t,{speechOptions:{engine:'qwen',voice:'Vivian',qwenKey:'fixture',qwen:async({validateOnly,onEvent,signal})=>{
    if(validateOnly)return {}
    synthesisSignal=signal
    onEvent({type:'audio',sampleRate:24000,pcm:Buffer.from(new Int16Array(2400).fill(1000).buffer).toString('base64')})
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
    throw new Error('Cancelled fixture')
  }}})
  const get=async path=>(await fetch(app.url+path)).json()
  const before=await get('/api/speech/config')
  let utterance=0
  for(const text of ['停停停，等一下，先打住。','打住，打住，打住。']) {
    await (await app.post('/api/reply',{source:'host',text:'说长一点',voiceOwner:'console-owner'})).text()
    const state=await(await app.pulse()).json(),turn=state.turn
    const response=await app.post('/api/airi/stage/audio/speech',{turn:turn.id,input:'你好。'},app.headers)
    const reader=response.body.getReader()
    assert.match(new TextDecoder().decode((await reader.read()).value),/"type":"audio"/)
    await app.event({type:'playback',event:'started',turn:turn.id,audioId:turn.audioId,playedChars:0})
    await app.event({type:'playback',event:'progress',turn:turn.id,audioId:turn.audioId,playedChars:3})
    await app.event({type:'speech-start',utterance:++utterance})
    assert.equal(synthesisSignal.aborted,false)
    await app.event({type:'transcript',utterance,text,final:true})
    assert.equal(synthesisSignal.aborted,true)
    await app.event({type:'speech-end',utterance})
    const after=await(await app.pulse()).json()
    assert.equal(after.run,state.run);assert.equal(after.capture,true);assert.equal(after.turn,null)
    const status=await get('/api/status'),answer=status.room.entries.findLast(e=>e.role==='assistant')
    assert.equal(answer.status,'cancelled');assert.equal(answer.interruptionReason,'host_stop')
    assert.equal(answer.playedChars,3);assert.ok(answer.timings.cancelRequestedAt>=answer.timings.ttsRequestedAt)
    assert.equal(status.director.intent,'stop');assert.equal(status.director.candidate,null)
    assert.equal((await(await app.event({type:'playback',event:'ended',turn:turn.id,audioId:turn.audioId,playedChars:7})).json()).accepted,false)
    await reader.cancel()
  }
  assert.deepEqual((await get('/api/speech/config')).effective,before.effective)
})

test('AIRI selected local speech streams PCM only for the current leased reply', async t => {
  const audio={type:'audio',sampleRate:24000,pcm:Buffer.alloc(4800).toString('base64')}
  let finish, started
  const pending=new Promise(resolve=>{finish=resolve})
  const app=await setup(t,{speechOptions:{engine:'aqua',fetchImpl:async(url,options)=>{
    if(url.endsWith('/health'))return Response.json({ok:true,engine:'aqua-v3'})
    assert.equal(url,'http://127.0.0.1:8793/tts')
    started=options.signal
    return new Response(new ReadableStream({async start(controller){
      controller.enqueue(new TextEncoder().encode(JSON.stringify(audio)+'\n'))
      await pending
      controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'done',firstPcmMs:250,totalMs:500})+'\n'));controller.close()
    }}))
  }}})
  await app.event({type:'speech-start',utterance:1})
  await app.event({type:'transcript',utterance:1,text:'小鲸鱼，你觉得今天怎么样？',final:true})
  await app.event({type:'speech-end',utterance:1})
  const state=await until(async()=>(await app.pulse()).json(),x=>x.turn?.done)
  const response=await app.post('/api/airi/stage/audio/speech',{turn:state.turn.id,input:'你好。'},app.headers)
  assert.match(response.headers.get('content-type'),/ndjson/)
  const reader=response.body.getReader()
  assert.ok(new TextDecoder().decode((await reader.read()).value).includes('"type":"audio"'))
  assert.equal(started.aborted,false)
  await app.post('/api/interrupt',{})
  assert.equal(started.aborted,true)
  finish();await reader.cancel()
  assert.equal((await app.post('/api/airi/stage/audio/speech',{turn:state.turn.id,input:'你好。'},app.headers)).status,409)
  const status=await(await fetch(app.url+'/api/status')).json()
  assert.equal(status.configuration.speechBackend,'aqua')
  assert.equal(status.configuration.voice,'local-reference')
})

test('speech selection is local, preserves credentials, and retains previous voice on failed preparation', async t => {
  const folder=mkdtempSync(join(tmpdir(),'cohost-voice-config-')),envPath=join(folder,'.env')
  t.after(()=>{assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));rmSync(folder,{recursive:true,force:true})})
  writeFileSync(envPath,'DEEPSEEK_API_KEY=kept-fixture\nSILICONFLOW_API_KEY=kept-voice-fixture\n')
  const app=await setup(t,{speechOptions:{fetchImpl:async()=>Response.json({ok:true,engine:'aqua-v3'}),qwenKey:'sk-fixture-not-a-real-key',qwen:async()=>{throw Error('secret-fixture-not-returned')}}})
  const old=await(await fetch(app.url+'/api/speech/config')).json()
  assert.equal((await app.post('/api/speech/config',{engine:'aqua'},{Origin:'https://other.invalid'})).status,403)
  assert.equal((await app.post('/api/speech/config',{engine:'aqua',revision:old.effective.revision})).status,200)
  assert.ok(readFileSync(envPath,'utf8').includes('DEEPSEEK_API_KEY=kept-fixture\nSILICONFLOW_API_KEY=kept-voice-fixture\n'))
  const previous=readFileSync(envPath,'utf8')
  const current=await(await fetch(app.url+'/api/speech/config')).json()
  const failed=await app.post('/api/speech/config',{engine:'qwen',voice:'Vivian',revision:current.effective.revision})
  assert.equal(failed.status,502)
  assert.ok(!(await failed.text()).includes('secret-fixture'))
  assert.equal(readFileSync(envPath,'utf8'),previous)
  const status=await(await fetch(app.url+'/api/status')).json()
  assert.equal(status.configuration.speechBackend,'aqua')
})

test('AIRI automatic turn runs without browser consumption and history follows played prefixes', async t => {
  const seen=[]
  const app=await setup(t,{reply:async function*(args){seen.push(args);yield '你好。';yield '继续聊。'}})
  await app.event({type:'speech-start',utterance:1})
  await app.event({type:'transcript',utterance:1,text:'小鲸鱼，你觉得今天怎么样？',final:true})
  await app.event({type:'speech-end',utterance:1})
  const state=await until(async()=> (await app.pulse()).json(),x=>x.turn?.done)
  assert.equal(seen.length,1);assert.equal(state.turn.text,'你好。继续聊。')
  const feedback=(event,playedChars)=>app.event({type:'playback',event,playedChars,turn:state.turn.id,audioId:state.turn.audioId})
  assert.equal((await(await feedback('started',0)).json()).accepted,true)
  await feedback('progress',3)
  await app.post('/api/interrupt',{})
  assert.equal((await(await feedback('ended',7)).json()).accepted,false)
  const next=await app.post('/api/reply',{source:'host',text:'继续',voiceOwner:'console-owner'})
  await next.text()
  assert.equal(seen[1].history.at(-1).content,'你好。','only completed audio enters history')
})

test('stage routes enforce origin, lease and stale utterance isolation', async t=>{
  const app=await setup(t)
  assert.equal((await app.post('/api/airi/stage/pulse',{stage:'web',owner:'stage-owner',ready:true,listening:true},{Origin:'https://evil.invalid'})).status,403)
  assert.equal((await app.post('/api/airi/stage/event',{type:'stopped'},{...app.headers,Authorization:'Bearer wrong'})).status,409)
  await app.event({type:'speech-start',utterance:10})
  assert.equal((await(await app.event({type:'transcript',utterance:9,text:'旧问题',final:true})).json()).accepted,false)
  const status=await(await fetch(app.url+'/api/status')).json()
  assert.equal(status.director.utterance,10)
  assert.equal(status.room.entries.some(entry=>entry.role==='host'),false)
  assert.equal(JSON.stringify(status).includes('speech-private'),false)
  assert.equal((await app.post('/api/airi/stop',{owner:'different-console'})).status,409)
  assert.equal((await app.post('/api/voice/start',{owner:'console-owner',output:true})).status,409)
  assert.equal((await app.post('/api/airi/stop',{owner:'console-owner'})).status,200)
  assert.equal((await app.event({type:'transcript',utterance:10,text:'迟到问题',final:true})).status,409)
})

test('speech proxy fixes provider and model, validates current reply, and cancels with turn', async t=>{
  const requests=[]
  const app=await setup(t,{airiOptions:{key:'speech-private',fetchImpl:async(url,options)=>{
    requests.push({url,options})
    const bytes=Buffer.alloc(44);bytes.write('RIFF');bytes.write('WAVE',8)
    return url.endsWith('transcriptions') ? Response.json({text:'合成识别'}) : new Response(bytes)
  }}})
  const form=new FormData();form.set('model','untrusted-model');form.set('file',new Blob([Buffer.alloc(50)]),'recording.wav')
  const response=await fetch(app.url+'/api/airi/stage/audio/transcriptions',{method:'POST',headers:app.headers,body:form})
  assert.equal(response.status,200)
  assert.equal(requests[0].options.body.get('model'),'FunAudioLLM/SenseVoiceSmall')
  const output=await app.post('/api/reply',{source:'host',text:'你好',voiceOwner:'console-owner'})
  await output.text()
  const {turn}=await(await app.pulse()).json()
  assert.equal((await app.post('/api/airi/stage/audio/speech',{turn:turn.id,input:'任意陌生文本'},app.headers)).status,400)
  const audio=await app.post('/api/airi/stage/audio/speech',{turn:turn.id,input:'你好。'},app.headers)
  assert.equal(audio.status,200)
  const sent=JSON.parse(requests.at(-1).options.body)
  assert.equal(sent.voice,'FunAudioLLM/CosyVoice2-0.5B:claire')
  await app.post('/api/interrupt',{})
  assert.equal((await app.post('/api/airi/stage/audio/speech',{turn:turn.id,input:'你好。'},app.headers)).status,409)
})

test('free motion starts on accepted audio playback and stale audio cannot restart it',async t=>{
 const motion={label:'侧目',frames:[{ms:1200,pose:{eyeX:0.5}}]}
 const app=await setup(t,{reply:async function*(){yield '你好。';yield '<act:'+JSON.stringify(motion)+'>'}})
 await app.post('/api/runtime-profile',{stage:'web',owner:'stage-owner',card:null,capabilities:testCapabilities()})
 await(await app.post('/api/reply',{source:'host',text:'试一次动作',voiceOwner:'console-owner'})).text()
 const read=()=>fetch(app.url+'/api/status').then(r=>r.json())
 let state=await read();assert.equal(state.performance.name,'sequence');assert.equal(state.performance.startedAt,null)
 const {turn}=await(await app.pulse()).json()
 const event=audioId=>app.event({type:'playback',event:'started',playedChars:0,turn:turn.id,audioId})
 assert.equal((await(await event('wrong')).json()).accepted,false)
 assert.equal((await read()).performance.startedAt,null)
 assert.equal((await(await event(turn.audioId)).json()).accepted,true)
 state=await read();const startedAt=state.performance.startedAt
 assert.equal(typeof startedAt,'number')
 assert.equal((await(await event(turn.audioId)).json()).accepted,false)
 assert.equal((await read()).performance.startedAt,startedAt)
 await app.post('/api/interrupt',{})
 assert.equal((await(await event(turn.audioId)).json()).accepted,false)
 assert.equal((await read()).performance.name,'idle')
})
