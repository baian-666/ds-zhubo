import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { AiriVoice } from '../apps/cohost/airi-voice.mjs'
import { createApp } from '../apps/cohost/server.mjs'

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
  const server=createApp({apiKey:'test-key',token:'',rehearsal:true,airiOptions:{key:'speech-private'},reply:async function*(){yield '你好。';yield '继续聊。'},...options})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})
  const url='http://127.0.0.1:'+server.address().port
  const post=(path,body,headers={})=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  const pulse=()=>post('/api/airi/stage/pulse',{stage:'web',owner:'stage-owner',ready:true,listening:true},{Origin:'http://127.0.0.1:5173'})
  await pulse()
  assert.equal((await post('/api/airi/start',{stage:'web',owner:'console-owner'})).status,200)
  const session=await(await pulse()).json()
  const headers={Origin:'http://127.0.0.1:5173',Authorization:'Bearer '+session.run+':stage-owner'}
  return {url,post,pulse,headers,event:body=>post('/api/airi/stage/event',body,headers)}
}
async function until(read,accept) {
  const end=Date.now()+3000
  while(Date.now()<end){const value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,20))}
  throw Error('Timed out')
}

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
