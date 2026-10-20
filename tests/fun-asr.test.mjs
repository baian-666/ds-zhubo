import test from 'node:test'
import assert from 'node:assert/strict'
import { FunAsrConnections, FunAsrSegment, verifyFunAsr } from '../apps/cohost/fun-asr.mjs'
import { AiriVoice } from '../apps/cohost/airi-voice.mjs'
import { ModuleSettings } from '../apps/cohost/module-settings.mjs'
import { createApp } from '../apps/cohost/server.mjs'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

class Socket extends EventTarget {
  constructor(){super();this.sent=[];this.bufferedAmount=0;this.readyState=0;Socket.latest=this}
  send(value){this.sent.push(value)}
  close(){this.closed=true}
  event(event,payload={}){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({header:{event,task_id:this.id},payload})}))}
  start(){this.readyState=1;this.dispatchEvent(new Event('open'));this.id=JSON.parse(this.sent[0]).header.task_id;this.event('task-started')}
  sentence(id,text,final=false){this.event('result-generated',{output:{sentence:{sentence_id:id,text,sentence_end:final}}})}
}
const setup=(options={})=>{const events=[];const task=new FunAsrSegment({key:'test',WebSocketImpl:Socket,emit:event=>events.push(event),...options});return {task,events,socket:Socket.latest}}

test('diagnostic compatible models preserve the default protocol and reject unknown models before opening',async()=>{
  for(const model of ['fun-asr-realtime','paraformer-realtime-v2','qwen-audio-3.0-asr-flash-streaming']) {
    const {task,socket}=setup({model});socket.start();await task.ready
    const request=JSON.parse(socket.sent[0])
    assert.equal(request.payload.model,model)
    assert.equal(request.payload.parameters.max_sentence_silence,650)
    task.close()
  }
  assert.throws(()=>setup({model:'unknown'}),/不支持/)
})

test('access probes accept empty-audio rejection only after a task starts; real input and credential errors still fail',async()=>{
  let code='NO_VALID_AUDIO_ERROR'
  class Provider extends Socket {
    constructor(){super();queueMicrotask(()=>this.start())}
    send(value){
      super.send(value)
      if(typeof value==='string' && JSON.parse(value).header.action==='finish-task')queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{
        data:JSON.stringify({header:{event:'task-failed',task_id:this.id,error_code:code}})
      })))
    }
  }
  await verifyFunAsr({key:'test',WebSocketImpl:Provider,model:'paraformer-realtime-v2'})
  code='AuthenticationFailed'
  await assert.rejects(verifyFunAsr({key:'test',WebSocketImpl:Provider}),/拒绝/)
  code='NO_VALID_AUDIO_ERROR'
  const task=new FunAsrSegment({key:'test',WebSocketImpl:Provider})
  await task.ready;task.write(Buffer.alloc(1024),0)
  await assert.rejects(task.finish(1),error=>error.providerCode==='NO_VALID_AUDIO_ERROR')
})

test('capture prepares two independent connections so a following segment can start before the prior final',async()=>{
  let sockets=0
  class Provider extends Socket {
    constructor(){super();sockets++;queueMicrotask(()=>this.start())}
    send(value){
      super.send(value)
      if(typeof value!=='string')return
      const message=JSON.parse(value)
      this.id=message.header.task_id
      if(message.header.action==='run-task')queueMicrotask(()=>this.event('task-started'))
      if(message.header.action==='finish-task')queueMicrotask(()=>this.event('task-finished'))
    }
  }
  const airi=new AiriVoice({realtimeKey:'test',realtimeOptions:{WebSocketImpl:Provider},recognition:()=>({provider:'dashscope'})})
  airi.pulse({stage:'desktop',owner:'renderer-one',ready:true});airi.start('desktop','control',true)
  try {
    const revision=airi.session.captureRevision
    await airi.prepareRecognition(revision)
    assert.equal(sockets,2)
    const first=airi.openRecognition(1,revision,()=>{}),second=airi.openRecognition(2,revision,()=>{})
    await Promise.all([first.ready,second.ready])
    assert.equal(sockets,2,'two adjacent segments must not establish another connection')
  } finally {airi.stop()}
})

test('answer preview uses all pending segments in frontend order and waits for missing earlier results',()=>{
  const airi=new AiriVoice()
  airi.recognitionTexts.set(1,null);airi.recognitionTexts.set(2,null)
  assert.equal(airi.previewRecognition(2,'后半段问题。'),null)
  airi.recognitionTexts.set(1,'前半段故事。')
  assert.equal(airi.previewRecognition(2,'后半段问题。'),'前半段故事。，后半段问题。')
  airi.acknowledgeRecognition(2)
  assert.equal(airi.recognitionTexts.size,0)
  airi.recognitionTexts.set(3,'未交付');airi.cancelRecognition()
  assert.equal(airi.previewRecognition(3,'下一句。'),null)
})

test('authenticated live ASR prepares a response before task finish and resumes cancel its audio lease',async t=>{
  class Provider extends Socket {
    constructor(){super();queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))})}
    send(value){super.send(value);if(typeof value==='string'){
      const message=JSON.parse(value)
      if(message.header.action==='run-task'){this.id=message.header.task_id;queueMicrotask(()=>this.event('task-started'))}
      if(message.header.action==='finish-task')queueMicrotask(()=>this.event('task-finished'))
    }}
  }
  const offers=[]
  const server=createApp({apiKey:'test',semanticEnabled:true,rehearsal:true,
    planner:async snapshot=>{offers.push(snapshot);return {action:'reply_host',hostIntent:'spontaneous',reason:'我接这个笑点。',text:'升级了。'}},
    airiOptions:{key:'sense',realtimeKey:'fun',realtimeOptions:{WebSocketImpl:Provider}},speechOptions:{engine:'siliconflow'}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(()=>{server.close();server.closeAllConnections()})
  const url='http://127.0.0.1:'+server.address().port
  const get=async path=>(await fetch(url+'/api/'+path)).json()
  const post=async(path,body,headers={})=>(await fetch(url+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})).json()
  const config=await get('services/config')
  await post('services/config',{module:'recognition',revision:config.recognition.revision,value:{provider:'dashscope',model:'fun-asr-realtime'}})
  const origin={Origin:'http://localhost:5174'}
  await post('airi/stage/pulse',{stage:'desktop',owner:'renderer',ready:true},origin)
  await post('airi/start',{stage:'desktop',owner:'control',capture:true})
  const pulse=await post('airi/stage/pulse',{stage:'desktop',owner:'renderer',ready:true},origin)
  const headers={...origin,Authorization:'Bearer '+pulse.run+':renderer','X-Cohost-Capture':String(pulse.captureRevision)}
  await post('airi/stage/pulse',{stage:'desktop',owner:'renderer',ready:true,listening:true,captureRevision:pulse.captureRevision},origin)
  const event=body=>post('airi/stage/event',{utterance:1,captureRevision:pulse.captureRevision,...body},headers)
  assert.equal((await event({type:'speech-start'})).accepted,true)
  const controller=new AbortController();t.after(()=>controller.abort())
  const stream=await fetch(url+'/api/airi/stage/recognition/open',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({utterance:1}),signal:controller.signal})
  const reader=stream.body.getReader();await reader.read()
  Provider.latest.sentence(0,'我家的猫把跑步机当成猫窝了。',true)
  let status
  for(let count=0;count<30;count++){status=await get('status');if(status.director.candidate)break;await delay(50)}
  assert.equal(offers[0]?.listeningOpportunity,true)
  assert.equal(status.hostSpeaking,true)
  assert.equal(status.room.entries.some(entry=>entry.role==='host'),false)
  assert.equal(status.room.entries.some(entry=>entry.role==='assistant'),false)
  await event({type:'speech-pause',paused:true})
  let active
  for(let count=0;count<20;count++){
    active=await post('airi/stage/pulse',{stage:'desktop',owner:'renderer',ready:true,listening:true,captureRevision:pulse.captureRevision},origin)
    if(active.turn?.text)break
    await delay(30)
  }
  assert.equal(active.turn?.listening,true)
  const played=await post('airi/stage/event',{type:'playback',turn:active.turn.id,audioId:active.turn.audioId,event:'started',playedChars:0},headers)
  assert.equal(played.accepted,true)
  await event({type:'speech-pause',paused:false})
  status=await get('status')
  assert.equal(status.busy,false)
  assert.equal(status.room.entries.findLast(entry=>entry.role==='assistant').status,'cancelled')
  await event({type:'speech-pause',paused:true,captureRevision:pulse.captureRevision-1}).then(value=>assert.equal(value.accepted,false))
  await reader.cancel()
})

test('duplex audio arrives before finish, only confirmed ordered sentences are delivered once',async()=>{
  const {task,socket,events}=setup()
  socket.start();await task.ready
  task.write(Buffer.alloc(3200),0)
  socket.sentence(0,'未确认草稿');socket.sentence(0,'小鲸鱼。',true);socket.sentence(0,'重复',true)
  socket.sentence(1,'你好',false)
  assert.equal(events.some(event=>event.type==='final'),false)
  assert.equal(Buffer.isBuffer(socket.sent[1]),true)
  const done=task.finish(1)
  socket.sentence(1,'你好吗？',true);socket.event('task-finished')
  assert.equal((await done).text,'小鲸鱼。你好吗？')
  assert.equal(events.filter(event=>event.type==='final').length,1)
  assert.equal(socket.closed,true)
})
test('rejects out-of-order audio, excess buffering, stale tasks and cancels without a final',async()=>{
  const controller=new AbortController();const {task,socket,events}=setup({signal:controller.signal})
  socket.start();await task.ready
  assert.throws(()=>task.write(Buffer.alloc(3200),1),/乱序/)
  socket.bufferedAmount=300000
  assert.throws(()=>task.write(Buffer.alloc(3200),0),/积压/)
  controller.abort();await assert.rejects(task.done,/取消/)
  socket.sentence(0,'迟到',true);socket.event('task-finished')
  assert.equal(events.some(event=>event.type==='final'),false)
})
test('bounds startup and finalization and rejects provider failures without leaking raw errors',async()=>{
  let {task}=setup({startTimeoutMs:10})
  await assert.rejects(task.ready,/连接超时/)
  await assert.rejects(task.done,/连接超时/)
  let next=setup({finishTimeoutMs:10});next.socket.start();await next.task.ready
  await assert.rejects(next.task.finish(0),/等待过久/)
  next=setup();next.socket.start();await next.task.ready
  next.socket.event('task-failed',{secret:'never expose'})
  await assert.rejects(next.task.done,error=>!error.message.includes('never expose')&&error.message.includes('拒绝'))
})
test('recognition selection persists independently and cannot accept mixed provider/model pairs',()=>{
  const modules=new ModuleSettings();const inference=modules.snapshot('inference');const old=modules.snapshot('recognition')
  const selected=modules.save('recognition',{provider:'dashscope',model:'fun-asr-realtime'},old.revision)
  assert.deepEqual(modules.snapshot('inference'),inference)
  assert.throws(()=>modules.save('recognition',{provider:'siliconflow',model:'fun-asr-realtime'},selected.revision),/无效/)
  assert.throws(()=>modules.save('recognition',old.value,old.revision),/更新/)
  assert.deepEqual(modules.save('recognition',old.value,selected.revision).value,old.value)
})
test('capture cancellation closes streaming input but preserves the playback lease',async()=>{
  const airi=new AiriVoice({key:'sense',realtimeKey:'fun',realtimeOptions:{WebSocketImpl:Socket},recognition:()=>({provider:'dashscope'})})
  airi.pulse({stage:'desktop',owner:'renderer-one',ready:true})
  airi.start('desktop','control',true)
  const run=airi.session.id;const revision=airi.session.captureRevision
  const task=airi.openRecognition(1,revision,()=>{})
  Socket.latest.start();await task.ready
  airi.setCapture('control',false)
  await assert.rejects(task.done,/停止/)
  assert.equal(airi.session.id,run);assert.equal(airi.session.capture,false);assert.equal(airi.segments.size,0)
  assert.throws(()=>airi.recognitionSegment(1,revision),/失效/)
  airi.stop()
})
test('completed tasks reuse a connection with new correlation IDs and release it on capture stop',async()=>{
  const connections=new FunAsrConnections()
  const first=setup({connections});first.socket.start();await first.task.ready
  const done=first.task.finish(0);first.socket.event('task-finished');await done
  assert.equal(first.socket.closed,undefined)
  const second=setup({connections});await Promise.resolve()
  assert.equal(second.socket,first.socket)
  const nextId=JSON.parse(first.socket.sent.at(-1)).header.task_id
  assert.notEqual(nextId,first.socket.id)
  first.socket.sentence(0,'旧任务迟到',true)
  assert.equal(second.events.length,0)
  first.socket.id=nextId;first.socket.event('task-started');await second.task.ready
  const next=second.task.finish(0);first.socket.event('task-finished');await next
  assert.equal((await next).text,'')
  connections.clear();assert.equal(first.socket.closed,true)
})

test('a stalled final replays identical audio once and only the winning final reaches listeners',async()=>{
  const sockets=[],events=[],frame=Buffer.alloc(1024,5)
  class Provider extends Socket {constructor(){super();sockets.push(this);queueMicrotask(()=>this.start())}}
  const task=new FunAsrSegment({key:'test',WebSocketImpl:Provider,finishHedgeMs:5,emit:event=>events.push(event)})
  await task.ready;task.write(frame,0);frame.fill(8)
  const done=task.finish(1)
  await delay(20)
  assert.equal(sockets.length,2)
  const sent=sockets[1].sent.find(Buffer.isBuffer)
  assert.deepEqual(sent,Buffer.alloc(1024,5),'retry owns the original samples, not a mutable caller buffer')
  sockets[1].sentence(0,'最终完整问题。',true);sockets[1].event('task-finished')
  const result=await done
  assert.equal(result.text,'最终完整问题。');assert.equal(result.asrAttempts,2)
  sockets[0].sentence(0,'迟到原结果',true);sockets[0].event('task-finished')
  assert.deepEqual(events.filter(e=>e.type==='final').map(e=>e.text),['最终完整问题。'])
  assert.equal(sockets[0].closed,true);assert.equal(task.audioFrames.length,0)
})

test('an original final cancels its retry, while a failed retry leaves the original available',async()=>{
  for(const retryFails of [false,true]) {
    const sockets=[],events=[],connections=new FunAsrConnections()
    class Provider extends Socket {constructor(){super();sockets.push(this);queueMicrotask(()=>this.start())}}
    const task=new FunAsrSegment({key:'test',WebSocketImpl:Provider,connections,finishHedgeMs:5,emit:event=>events.push(event)})
    await task.ready;task.write(Buffer.alloc(1024,5),0);const done=task.finish(1)
    await delay(20);assert.equal(sockets.length,2)
    if(retryFails)sockets[1].event('task-failed')
    sockets[0].sentence(0,'原连接的最终结果。',true);sockets[0].event('task-finished')
    assert.equal((await done).text,'原连接的最终结果。')
    await delay(5)
    assert.equal(sockets[1].closed,true);assert.equal(connections.hedging,false)
    assert.equal(events.filter(e=>e.type==='final').length,1)
    connections.clear()
  }
})

test('capture cancellation stops a pending retry and the capture pool admits at most one hedge',async()=>{
  const sockets=[],events=[],connections=new FunAsrConnections(),controller=new AbortController()
  class Provider extends Socket {constructor(){super();sockets.push(this);queueMicrotask(()=>this.start())}}
  const options={key:'test',WebSocketImpl:Provider,connections,finishHedgeMs:5,signal:controller.signal,emit:event=>events.push(event)}
  const one=new FunAsrSegment(options),two=new FunAsrSegment(options)
  await Promise.all([one.ready,two.ready])
  one.write(Buffer.alloc(1024),0);two.write(Buffer.alloc(1024),0)
  const pending=[one.finish(1),two.finish(1)]
  await delay(20);assert.equal(sockets.length,3,'two originals share just one extra task')
  controller.abort();assert.deepEqual((await Promise.allSettled(pending)).map(r=>r.status),['rejected','rejected'])
  sockets[2].sentence(0,'取消后结果',true);sockets[2].event('task-finished');await delay(5)
  assert.equal(events.some(e=>e.type==='final'),false);assert.equal(connections.hedging,false)
  assert.ok(sockets.every(socket=>socket.closed));connections.clear()
})

test('a timely final starts no duplicate task',async()=>{
  let calls=0
  class Provider extends Socket {constructor(){super();calls++;queueMicrotask(()=>this.start())}}
  const task=new FunAsrSegment({key:'test',WebSocketImpl:Provider,finishHedgeMs:30})
  await task.ready;task.write(Buffer.alloc(1024),0)
  const done=task.finish(1);Socket.latest.sentence(0,'及时结果。',true);Socket.latest.event('task-finished')
  await done;await delay(40);assert.equal(calls,1)
})

test('a delayed final leaves the warmed foreground reserve available for the next live segment',async()=>{
  const sockets=[],connections=new FunAsrConnections(),metrics=[]
  class Provider extends Socket {
    constructor(){super();sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))})}
    send(value){
      super.send(value)
      if(typeof value!=='string')return
      const message=JSON.parse(value)
      if(message.header.action==='run-task'){
        this.id=message.header.task_id
        queueMicrotask(()=>this.event('task-started'))
      }
    }
  }
  const warm=[0,1].map(()=>new FunAsrSegment({key:'test',WebSocketImpl:Provider,connections}))
  await Promise.all(warm.map(task=>task.ready))
  for(let i=0;i<warm.length;i++){const done=warm[i].finish(0);sockets[i].event('task-finished');await done}
  const task=new FunAsrSegment({key:'test',WebSocketImpl:Provider,connections,finishHedgeMs:5,onMetric:event=>metrics.push(event)})
  await task.ready;task.write(Buffer.alloc(1024,7),0);const done=task.finish(1)
  await delay(20)
  assert.equal(sockets.length,3,'retry must not steal the last foreground socket')
  assert.equal(sockets[0].sent.some(Buffer.isBuffer),false)
  const following=new FunAsrSegment({key:'test',WebSocketImpl:Provider,connections})
  await following.ready
  assert.equal(following.socket,sockets[0],'the next live segment can start warm')
  assert.deepEqual(sockets[2].sent.find(Buffer.isBuffer),Buffer.alloc(1024,7))
  sockets[2].sentence(0,'完整转写。',true);sockets[2].event('task-finished')
  assert.equal((await done).text,'完整转写。')
  await delay(5)
  assert.deepEqual(metrics.map(event=>event.type),['hedge-start','hedge-ready','hedge-won'])
  assert.equal(connections.hedging,false)
  following.close()
  connections.clear()
})

test('a busy retry slot is checked again within the admission bound and cancellation revokes the wait',async()=>{
  for(const cancel of [false,true]) {
    const sockets=[],connections=new FunAsrConnections(),release=connections.claimHedge()
    class Provider extends Socket {constructor(){super();sockets.push(this);queueMicrotask(()=>this.start())}}
    const task=new FunAsrSegment({key:'test',WebSocketImpl:Provider,connections,finishHedgeMs:5})
    await task.ready;task.write(Buffer.alloc(1024),0);const done=task.finish(1)
    await delay(20);assert.equal(sockets.length,1)
    if(cancel)task.close(Object.assign(new Error('cancelled'),{status:409}))
    release();await delay(220)
    if(cancel){await assert.rejects(done);assert.equal(sockets.length,1)}
    else {
      assert.equal(sockets.length,2)
      sockets[1].sentence(0,'重试结果。',true);sockets[1].event('task-finished')
      assert.equal((await done).text,'重试结果。')
    }
    connections.clear()
  }
})
test('HTTP streaming relay preserves speech configuration and supports switching back after capture',async t=>{
  class Provider extends Socket {
    constructor(){super();queueMicrotask(()=>this.start())}
    send(value){
      super.send(value)
      if(typeof value!=='string')return
      const message=JSON.parse(value)
      if(message.header.action==='run-task'){
        this.id=message.header.task_id
        queueMicrotask(()=>this.event('task-started'))
      }
      if(message.header.action==='finish-task')queueMicrotask(()=>{this.sentence(0,'小鲸鱼你好。',true);this.event('task-finished')})
    }
  }
  const server=createApp({airiOptions:{key:'sense',realtimeKey:'fun',realtimeOptions:{WebSocketImpl:Provider}},speechOptions:{engine:'siliconflow'}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(()=>{server.close();server.closeAllConnections()})
  const url='http://127.0.0.1:'+server.address().port
  const get=async path=>(await fetch(url+'/api/'+path)).json()
  const post=(path,body,headers={})=>fetch(url+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  const config=await get('services/config'),speech=await get('speech/config')
  assert.equal((await post('services/config',{module:'recognition',revision:config.recognition.revision,value:{provider:'dashscope',model:'fun-asr-realtime'}})).status,200)
  const origin={Origin:'http://localhost:5174'}
  await post('airi/stage/pulse',{stage:'desktop',owner:'renderer-one',ready:true},origin)
  assert.equal((await post('airi/start',{stage:'desktop',owner:'control',capture:true})).status,200)
  const pulse=await (await post('airi/stage/pulse',{stage:'desktop',owner:'renderer-one',ready:true},origin)).json()
  const headers={...origin,Authorization:'Bearer '+pulse.run+':renderer-one','X-Cohost-Capture':String(pulse.captureRevision)}
  assert.equal(pulse.recognition,'dashscope')
  const stream=await post('airi/stage/recognition/open',{utterance:1},headers)
  const reader=stream.body.getReader();const decoder=new TextDecoder()
  assert.match(decoder.decode((await reader.read()).value),/ready/)
  assert.equal((await post('airi/stage/recognition/chunk',{utterance:1,sequence:0,pcm:Buffer.alloc(3200).toString('base64')},headers)).status,200)
  assert.equal((await post('airi/stage/recognition/finish',{utterance:1,sequence:1},headers)).status,200)
  let text='';for(;;){const result=await reader.read();if(result.done)break;text+=decoder.decode(result.value)}
  assert.match(text,/"type":"final"/)
  assert.equal((await get('status')).room.entries.some(item=>item.text==='小鲸鱼你好。'),false)
  await post('airi/capture',{owner:'control',capture:false})
  const current=await get('services/config')
  assert.equal((await post('services/config',{module:'recognition',revision:current.recognition.revision,value:config.recognition.value})).status,200)
  assert.deepEqual((await get('speech/config')).effective,speech.effective)
  assert.equal((await post('airi/stage/recognition/chunk',{utterance:1,sequence:1,pcm:'AAA='},headers)).status,409)
})
