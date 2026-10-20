import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeechOutput } from '../apps/cohost/speech-output.mjs'
import { validateQwenClone, loadQwenClone } from '../apps/cohost/qwen-clone.mjs'
import { streamQwen, createQwenSessionCache, CLONE_MODELS, unavailableModelMessage } from '../scripts/qwen-realtime-client.mjs'

const clone={model:CLONE_MODELS[0],voice:'qwen-tts-vc-test-voice-fixture'}
const key='sk-fixture-not-a-real-credential'
test('Qwen clone passes its paired model and voice through prepare and synthesis, then switches back to preset',async()=>{
  const calls=[]
  const speech=new SpeechOutput({engine:'qwen',voice:'克隆音色',qwenClone:clone,qwenKey:key,qwen:async input=>{calls.push(input);return {chunks:1}}})
  assert.equal(speech.snapshot().model,clone.model)
  assert.equal(speech.snapshot().capabilities.reference,true)
  await speech.prepare();await speech.stream('你好',{emit:()=>{}})
  assert.equal(calls.length,3)
  assert.deepEqual(calls.map(call=>Boolean(call.validateOnly)),[true,true,false])
  for(const call of calls){assert.equal(call.model,clone.model);assert.equal(call.voice,clone.voice)}
  speech.configure('qwen','Vivian');await speech.prepare()
  for(const call of calls.slice(3)){assert.equal(call.model,'qwen3-tts-flash-realtime');assert.equal(call.voice,'Vivian')}
  assert.equal(speech.snapshot().capabilities.reference,false);speech.close()
})
test('clone metadata fails closed, unavailable model errors remain actionable and sanitized',async()=>{
  assert.throws(()=>validateQwenClone({model:'untrusted',voice:clone.voice}),/对应模型无效/)
  assert.throws(()=>validateQwenClone({...clone,voice:'Vivian'}),/对应模型无效/)
  assert.throws(()=>loadQwenClone(new URL('./absent-clone-fixture.json',import.meta.url)),/请先配置/)
  const speech=new SpeechOutput({engine:'qwen',voice:'克隆音色',qwenClone:clone,qwenKey:key,qwen:async()=>{throw Error(unavailableModelMessage)}})
  await assert.rejects(speech.prepare(),error=>error.status===502&&error.message===unavailableModelMessage)
  speech.close()
})
class Socket extends EventTarget {
  static last
  constructor(url){super();this.url=url;this.readyState=0;this.sent=[];Socket.last=this;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))})}
  send(value){this.sent.push(JSON.parse(value))}
  close(){this.readyState=3}
  emit(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}))}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('clone transport uses selected model, separates cache by model, and waits for session.updated',async t=>{
  const cache=createQwenSessionCache();t.after(()=>cache.clear())
  let previous
  for(const model of CLONE_MODELS){
    const request=streamQwen({key,model,voice:clone.voice,validateOnly:true,sessionCache:cache,WebSocketImpl:Socket})
    await tick();const socket=Socket.last
    assert.equal(new URL(socket.url).searchParams.get('model'),model)
    if(previous)assert.equal(previous.readyState,3)
    assert.equal(socket.sent[0].session.voice,clone.voice)
    socket.emit({type:'session.created'})
    assert.equal(socket.sent.length,1)
    socket.emit({type:'session.updated'});await request;previous=socket
  }
  const request=streamQwen({key,model:CLONE_MODELS[1],voice:clone.voice,text:'克隆试听',sessionCache:cache,WebSocketImpl:Socket})
  assert.equal(Socket.last,previous)
  previous.emit({type:'response.audio.delta',delta:Buffer.alloc(4800,1).toString('base64')});previous.emit({type:'response.done'})
  assert.equal((await request).model,CLONE_MODELS[1])
})
test('provider model-not-exist close is mapped without exposing raw reason',async()=>{
  const request=streamQwen({key,...clone,validateOnly:true,WebSocketImpl:Socket})
  const rejected=assert.rejects(request,error=>error.message===unavailableModelMessage)
  await tick();const event=new Event('close');Object.assign(event,{code:1007,reason:'Model not exist. private detail'});Socket.last.dispatchEvent(event);await rejected
  await assert.rejects(streamQwen({key,model:'unknown',voice:clone.voice,validateOnly:true,WebSocketImpl:Socket}),/请选择音色/)
})
