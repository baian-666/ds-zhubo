import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createApp } from '../apps/cohost/server.mjs'
import { AiriVoice } from '../apps/cohost/airi-voice.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'

async function setup(t, options = {}) {
  const folder = mkdtempSync(join(tmpdir(),'cohost-media-'))
  const calls = []
  const path=join(folder,'session.sqlite')
  const server = createApp({apiKey:'',sessionPath:path,speechOptions:{engine:'index',fetchImpl:async (url,options)=>{
    if (url.endsWith('/health')) return Response.json({ok:true,engine:'index-2.5'})
    calls.push(JSON.parse(options.body))
    return new Response(JSON.stringify({type:'audio',sampleRate:22050,pcm:Buffer.alloc(4410).toString('base64')})+'\n'+JSON.stringify({type:'done',firstPcmMs:5,totalMs:10})+'\n')
  }},...options})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));rmSync(folder,{recursive:true,force:true})})
  const url='http://127.0.0.1:'+server.address().port
  const get=path=>fetch(url+'/api/'+path).then(r=>r.json())
  const post=(path,body,headers={})=>fetch(url+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  return {get,post,calls,folder,path}
}

test('configuration revision prevents stale windows overwriting a saved voice',async t=>{
  const app=await setup(t)
  const old=await app.get('speech/config')
  assert.equal(old.effective.capabilities.transport,'pcm-stream')
  assert.equal(old.effective.capabilities.emotion,false)
  assert.equal((await app.post('speech/config',{engine:'index',revision:old.effective.revision})).status,200)
  const current=await app.get('speech/config')
  assert.notEqual(current.effective.revision,old.effective.revision)
  assert.equal((await app.post('speech/config',{engine:'siliconflow',revision:old.effective.revision})).status,409)
  assert.equal((await app.get('speech/config')).effective.revision,current.effective.revision)
  assert.equal(current.persistence.storage,'sqlite')
  assert.ok(Number.isSafeInteger(current.persistence.savedAt))
  assert.equal((await app.post('speech/config',{engine:'index'})).status,409)
})

test('changing voice discards an unheard prepared reply from the previous voice',async t=>{
  const scheduler=new Scheduler(),director=new Director({scheduler})
  const app=await setup(t,{scheduler,director})
  const old=await app.get('speech/config')
  let closed=false
  director.candidate={id:1,revision:director.revision,expiresAt:Date.now()+6500,listening:true,text:'完整分句。',
    preparedSpeech:{ready:true,close(){closed=true}}}
  assert.equal((await app.post('speech/config',{engine:'index',revision:old.effective.revision})).status,200)
  assert.equal(closed,true)
  assert.equal(director.candidate,null)
})

test('validation and persistence failure keep the published effective configuration',async t=>{
  const app=await setup(t,{speechOptions:{engine:'index',fetchImpl:async()=>Response.json({ok:true,engine:'wrong-worker'})}})
  const before=await app.get('speech/config')
  assert.equal((await app.post('speech/config',{engine:'index',revision:before.effective.revision})).status,503)
  assert.deepEqual((await app.get('speech/config')).effective,before.effective)
  // A failed SQLite transaction cannot publish the candidate voice.
  const other=await setup(t)
  const database=new DatabaseSync(other.path)
  database.exec("CREATE TRIGGER reject_settings BEFORE UPDATE ON runtime_settings BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;")
  database.close()
  const original=await other.get('speech/config')
  assert.equal((await other.post('speech/config',{engine:'index',revision:original.effective.revision})).status,503)
  assert.deepEqual((await other.get('speech/config')).effective,original.effective)
})

test('preview uses the active adapter and one stage without microphone or LLM',async t=>{
  const app=await setup(t,{apiKey:'fixture',reply:async function*(){assert.fail('Preview cannot call the LLM')}})
  const pulse=(stage,owner)=>app.post('airi/stage/pulse',{stage,owner,ready:true,listening:false},{Origin:`http://127.0.0.1:${stage==='desktop'?5174:5173}`}).then(r=>r.json())
  await pulse('web','web-renderer');await pulse('desktop','desktop-renderer')
  const {effective}=await app.get('speech/config')
  assert.equal((await app.post('speech/preview',{revision:'old'})).status,409)
  const preview=await app.post('speech/preview',{revision:effective.revision})
  assert.equal(preview.status,200)
  assert.equal((await preview.json()).stage,'desktop')
  const state=await pulse('desktop','desktop-renderer')
  assert.equal(state.capture,false)
  assert.equal((await pulse('web','web-renderer')).run,null)
  assert.equal((await pulse('desktop','other-renderer')).run,null)
  assert.equal((await app.post('speech/preview',{revision:effective.revision})).status,409)
  const headers={Origin:'http://127.0.0.1:5174',Authorization:`Bearer ${state.run}:desktop-renderer`}
  const speech=await app.post('airi/stage/audio/speech',{turn:state.turn.id,input:state.turn.text},headers)
  assert.equal(speech.status,200)
  assert.match(await speech.text(),/"sampleRate":22050/)
  assert.equal(app.calls[0].text,state.turn.text)
  assert.equal((await app.post('speech/config',{engine:'index',revision:effective.revision})).status,409)
  await app.post('interrupt',{})
  assert.equal((await app.post('airi/stage/audio/speech',{turn:state.turn.id,input:state.turn.text},headers)).status,409)
  assert.equal((await app.get('speech/config')).preview,false)
  assert.equal((await app.post('live/start',{})).status,200)
})

test('a lease binds the selected renderer before its first response and waits for capture readiness',()=>{
  const voice=new AiriVoice({key:'fixture'})
  voice.pulse({stage:'web',owner:'first-window',ready:true})
  voice.pulse({stage:'web',owner:'second-window',ready:true})
  assert.throws(()=>voice.start('web','not-ready-window',false,'not-ready-window'),/尚未连接/)
  voice.start('web','second-window',false)
  assert.equal(voice.pulse({stage:'web',owner:'first-window',ready:true}).run,null)
  assert.ok(voice.pulse({stage:'web',owner:'second-window',ready:true}).run)
  voice.start('web','second-window',true)
  voice.pulse({stage:'web',owner:'second-window',ready:true,listening:false})
  assert.equal(voice.snapshot().ready,true)
  assert.equal(voice.snapshot().captureReady,false)
  voice.pulse({stage:'web',owner:'second-window',ready:true,listening:true,captureRevision:voice.session.captureRevision})
  assert.equal(voice.snapshot().ready,true)
  assert.equal(voice.snapshot().captureReady,true)
  voice.stop()
})
