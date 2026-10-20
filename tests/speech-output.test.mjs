import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeechOutput } from '../apps/cohost/speech-output.mjs'
import { createQwenSessionCache } from '../scripts/qwen-realtime-client.mjs'
import { AUDIO_MODEL } from '../scripts/qwen-audio-client.mjs'

const audio = { type:'audio', sampleRate:24000, pcm:Buffer.alloc(4800).toString('base64') }
const encode = events => events.map(x=>JSON.stringify(x)+'\n').join('')

test('empty-task refresh leaves the last live connection available to the first spoken sentence',async()=>{
  const key='sk-fixture',voice=AUDIO_MODEL+'-fixture-'+'a'.repeat(32)
  for(const count of [1,2]) {
    let release,borrowed
    const output=new SpeechOutput({engine:'qwen',voice:'克隆音色',qwenKey:key,qwenClone:{model:AUDIO_MODEL,voice},qwen:options=>{
      borrowed=options.sessionCache.take(key,voice,AUDIO_MODEL)
      return new Promise(resolve=>{release=resolve})
    }})
    for(let index=0;index<count;index++)output.cache.put({readyState:1,close(){this.readyState=3}},key,voice,AUDIO_MODEL)
    const refreshing=output.maintainWarmth()
    assert.equal(Boolean(borrowed),count===2)
    assert.equal(output.cache.available(),1,'a cancelled speculative task must not force the first sentence to reconnect')
    const foreground=output.cache.take(key,voice,AUDIO_MODEL)
    assert.equal(foreground.readyState,1)
    release({});await refreshing
    foreground.close();borrowed?.close();output.close()
  }
})

test('silent maintenance fills only missing sockets without borrowing the ready connection',async()=>{
  const calls=[],releases=[]
  const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-fixture',qwen:options=>{
    calls.push(options);assert.equal(options.sessionCache.take(),undefined)
    return new Promise(resolve=>releases.push(()=>{options.sessionCache.put({readyState:1,close(){this.readyState=3}},options.key,options.voice,options.model);resolve({})}))
  }})
  const existing={readyState:1,close(){this.readyState=3}}
  output.cache.put(existing,'sk-fixture','Vivian')
  const work=output.maintainWarmth()
  assert.equal(calls.length,1);assert.equal(calls[0].validateOnly,true);assert.equal(calls[0].text,undefined)
  await output.maintainWarmth();assert.equal(calls.length,1)
  assert.equal(output.cache.take('sk-fixture','Vivian'),existing)
  releases[0]();await work;assert.equal(output.cache.available(),1)
  output.close()
})

test('aged live connections remain usable while their replacements are connecting',()=>{
  const cache=createQwenSessionCache({maxIdle:2}),socket={readyState:1,close(){this.readyState=3}}
  cache.put(socket,'key','voice')
  assert.equal(cache.available(0),0)
  assert.equal(socket.readyState,1)
  assert.equal(cache.take('key','voice'),socket)
  cache.clear()
})

test('capture stop cancels maintenance, closes late sockets and does not affect ordinary speech',async()=>{
  const requests=[],releases=[]
  const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-fixture',qwen:options=>{
    requests.push(options);return new Promise(resolve=>releases.push(resolve))
  }})
  const work=output.maintainWarmth();output.cancelWarmth()
  assert.ok(requests.every(request=>request.signal.aborted))
  const late={readyState:1,close(){this.readyState=3}}
  requests[0].sessionCache.put(late,'sk-fixture','Vivian')
  assert.equal(late.readyState,3)
  releases.forEach(resolve=>resolve({}));await work
  assert.equal(output.pending.size,0);assert.equal(output.cache.available(),0)
  output.close()
})

test('two concurrent cloud sentences retain separate warm connections and clear both on shutdown', () => {
  const cache=createQwenSessionCache({maxIdle:2})
  const socket=()=>({readyState:1,close(){this.readyState=3}})
  const one=socket(),two=socket()
  cache.put(one,'key','voice');cache.put(two,'key','voice')
  assert.equal(one.readyState,1)
  const acquired=[cache.take('key','voice'),cache.take('key','voice')]
  assert.equal(new Set(acquired).size,2)
  assert.ok(acquired.includes(one)&&acquired.includes(two))
  assert.equal(cache.take('key','voice'),undefined)
  for(const item of acquired)cache.put(item,'key','voice')
  cache.clear();assert.equal(one.readyState,3);assert.equal(two.readyState,3)
})

test('cloud prepare warms both playback slots before capture, with no speech text', async () => {
  const calls=[],releases=[]
  const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-test-fixture-not-real',qwen:request=>{
    calls.push(request)
    return new Promise(resolve=>releases.push(resolve))
  }})
  const prepared=output.prepare()
  try {
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(calls.length,2)
    assert.ok(calls.every(x=>x.validateOnly===true && !x.text))
  }finally{releases.forEach(resolve=>resolve({}));await prepared;output.close()}
})

test('failed warmup cancels its sibling and releases configuration ownership', async () => {
  let calls=0,siblingAborted=false
  const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-test-fixture-not-real',qwen:request=>{
    if(++calls===1)return Promise.reject(new Error('provider offline'))
    return new Promise((_,reject)=>request.signal.addEventListener('abort',()=>{siblingAborted=true;reject(new Error('cancelled'))},{once:true}))
  }})
  await assert.rejects(output.prepare(),/百炼连接失败/)
  assert.equal(calls,2);assert.equal(siblingAborted,true);assert.equal(output.pending.size,0)
  output.configure('qwen','Cherry');output.close()
})

test('closing the output cancels both warmup requests and leaves no pending work', async () => {
  let aborted=0
  const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-test-fixture-not-real',qwen:request=>new Promise((_,reject)=>{
    request.signal.addEventListener('abort',()=>{aborted++;reject(new Error('cancelled'))},{once:true})
  })})
  const prepared=output.prepare()
  assert.throws(()=>output.configure('qwen','Cherry'),/结束/)
  output.close()
  await assert.rejects(prepared)
  assert.equal(aborted,2);assert.equal(output.pending.size,0)
})

test('Qwen prepares the next sentence while the first is still generating, with two active requests at most', async () => {
  const started=[], releases=new Map(), events=[]
  const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-test-fixture-not-real',qwen:async options=>{
    started.push(options.text)
    await new Promise(resolve=>releases.set(options.text,resolve))
    options.onEvent(audio)
    return {}
  }})
  const jobs=['one','two','three'].map(text=>output.stream(text,{emit:event=>events.push([text,event.type])}))
  try {
    await new Promise(resolve=>setImmediate(resolve))
    assert.deepEqual(started,['one','two'])
    releases.get('two')()
    await jobs[1]
    await new Promise(resolve=>setImmediate(resolve))
    assert.deepEqual(started,['one','two','three'])
    assert.deepEqual(events,[['two','audio'],['two','done']])
  } finally {
    output.close()
    for(const release of releases.values())release()
    await Promise.allSettled(jobs)
  }
})

test('Index style belongs to each queued request and does not leak to the next reply or another engine', async () => {
  for(const engine of ['index','aqua']) {
    const sent=[]
    const output=new SpeechOutput({engine,fetchImpl:async(_url,options)=>{
      sent.push(JSON.parse(options.body))
      return new Response(encode([{...audio,sampleRate:engine==='index'?22050:24000},{type:'done'}]))
    }})
    await Promise.all([
      output.stream('太好了。',{speechStyle:'happy',emit:()=>{}}),
      output.stream('我在听。',{speechStyle:'gentle',emit:()=>{}}),
      output.stream('下一件事。',{emit:()=>{}}),
    ])
    assert.deepEqual(sent.map(x=>x.style),engine==='index'?['happy','gentle','neutral']:[undefined,undefined,undefined])
    output.close()
  }
})

test('cancelling a cloud turn stops both active sentences and removes queued speech', async () => {
  const started=[], controller=new AbortController(), frames=[]
  const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-test-fixture-not-real',qwen:async options=>{
    started.push(options.text)
    if(options.text!=='fresh')await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}))
    options.onEvent(audio)
    return {}
  }})
  const jobs=['one','two','queued'].map(text=>output.stream(text,{turnSignal:controller.signal,emit:event=>frames.push(event)}))
  const rejected=jobs.map(job=>assert.rejects(job,/已取消/))
  await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(started,['one','two'])
  controller.abort()
  await Promise.all(rejected)
  assert.equal(frames.length,0)
  assert.equal(output.pending.size,0)
  await output.stream('fresh',{emit:event=>frames.push(event)})
  assert.deepEqual(started,['one','two','fresh'])
  assert.deepEqual(frames.map(event=>event.type),['audio','done'])
  output.close()
})

test('Index preserves 22050 Hz PCM and rejects a worker from another engine', async () => {
  const frames=[]
  const output=new SpeechOutput({engine:'index',fetchImpl:async url=>{
    assert.ok(url.startsWith('http://127.0.0.1:8794/'))
    if(url.endsWith('/health'))return Response.json({ok:true,engine:'index-2.5'})
    return new Response(encode([{...audio,sampleRate:22050},{type:'done',firstPcmMs:1700,totalMs:3200}]))
  }})
  await output.prepare()
  await output.stream('你好，小鲸鱼。',{emit:frame=>frames.push(frame)})
  assert.equal(frames[0].sampleRate,22050)
  assert.equal(frames.at(-1).type,'done')
  assert.equal(output.snapshot().engine,'index')
  output.close()
  const wrong=new SpeechOutput({engine:'index',fetchImpl:async()=>Response.json({ok:true,engine:'aqua-v3'})})
  await assert.rejects(wrong.prepare(),/尚未就绪/)
  wrong.close()
})

test('Index startup selects its own worker and does not resample an unexpected stream', async () => {
  let ready=false
  const output=new SpeechOutput({engine:'index',startLocal:async engine=>{assert.equal(engine,'index');ready=true},
    fetchImpl:async url=>{
      if(!ready)throw Error('offline')
      if(url.endsWith('/health'))return Response.json({ok:true,engine:'index-2.5'})
      return new Response(encode([audio,{type:'done',firstPcmMs:1,totalMs:2}]))
    }})
  await output.prepare()
  await assert.rejects(output.stream('测试',{emit:()=>assert.fail('Wrong sample rate')}),/格式异常/)
  output.close()
})

test('local speech relays PCM before completion and serializes concurrent segments', async () => {
  let finish, calls=0
  const firstDone=new Promise(resolve=>{finish=resolve})
  const output=new SpeechOutput({engine:'aqua',fetchImpl:async (url, options)=>{
    assert.equal(url,'http://127.0.0.1:8793/tts');assert.ok(options.signal)
    calls++
    return new Response(new ReadableStream({ async start(controller){
      controller.enqueue(new TextEncoder().encode(encode([audio])))
      if(calls===1)await firstDone
      controller.enqueue(new TextEncoder().encode(encode([{type:'done',firstPcmMs:200,totalMs:300}])));controller.close()
    }}),{headers:{'Content-Type':'application/x-ndjson'}})
  }})
  const frames=[], second=[]
  const one=output.stream('第一句',{emit:x=>frames.push(x)})
  const two=output.stream('第二句',{emit:x=>second.push(x)})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(calls,1);assert.equal(frames[0].type,'audio');assert.equal(second.length,0)
  assert.throws(()=>output.configure('qwen','Vivian'),/结束/)
  finish();await Promise.all([one,two])
  assert.equal(calls,2);assert.equal(frames.at(-1).type,'done');assert.equal(second.at(-1).type,'done')
  assert.equal(output.pending.size,0);output.close()
})

test('cancelling a queued speech request does not skip the preceding active request', async () => {
  let finish, calls=0
  const blocked=new Promise(resolve=>{finish=resolve})
  const output=new SpeechOutput({engine:'aqua',fetchImpl:async ()=>{
    calls++;if(calls===1)await blocked
    return new Response(encode([audio,{type:'done',firstPcmMs:200,totalMs:300}]))
  }})
  const controller=new AbortController()
  const first=output.stream('一',{emit:()=>{}})
  const queued=output.stream('二',{signal:controller.signal,emit:()=>{assert.fail('Cancelled PCM')}})
  const rejected=assert.rejects(queued,/已取消/)
  controller.abort()
  const third=output.stream('三',{emit:()=>{}})
  await rejected;await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1)
  finish();await Promise.all([first,third]);assert.equal(calls,2);output.close()
})

test('incomplete or malformed local speech fails without exposing upstream details', async () => {
  for(const frames of [[audio],[{...audio,sampleRate:32000}],[{type:'error',message:'secret-fixture-not-returned'}]]) {
    const output=new SpeechOutput({engine:'aqua',fetchImpl:async ()=>new Response(encode(frames))})
    await assert.rejects(output.stream('测试',{emit:()=>{}}),error=>!error.message.includes('secret-fixture') && error.status===502)
    assert.equal(output.pending.size,0);output.close()
  }
})

test('a brief worker release after cancellation does not fail the next sentence', async () => {
  let calls=0
  const output=new SpeechOutput({engine:'aqua',fetchImpl:async()=>{
    calls++
    if(calls===1)return new Response('{}',{status:409})
    return new Response(encode([audio,{type:'done',firstPcmMs:200,totalMs:300}]))
  }})
  const frames=[]
  await output.stream('新一句',{emit:value=>frames.push(value)})
  assert.equal(calls,2)
  assert.equal(frames[0].type,'audio')
  assert.equal(frames.at(-1).type,'done')
  output.close()
})

test('Qwen speech uses the configured fixed voice, cache and linked cancellation', async () => {
  const controller=new AbortController(), events=[]
  const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-test-fixture-not-real',qwen:async options=>{
    assert.equal(options.voice,'Vivian');assert.ok(options.sessionCache)
    if(options.validateOnly)return {}
    options.onEvent(audio)
    await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}))
    options.onEvent(audio)
    return {}
  }})
  await output.prepare()
  const request=output.stream('测试',{turnSignal:controller.signal,emit:x=>events.push(x)})
  const rejected=assert.rejects(request,/已取消/)
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await rejected
  assert.equal(events.length,1);output.close()
  assert.throws(()=>new SpeechOutput({engine:'arbitrary',voice:'x'}),/无效/)
})

