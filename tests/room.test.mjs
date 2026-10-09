import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { createApp } from '../apps/cohost/server.mjs'

function room() {
  let time=1000
  const scheduler=new Scheduler({ now:()=>time })
  const director=new Director({ scheduler, now:()=>time })
  const enqueue=(id, extra={})=>scheduler.enqueue({ id, platform:'manual',userId:id,text:'助播你怎么看？',mentioned:true,...extra })
  return {scheduler,director,enqueue,advance:ms=>{time+=ms}}
}
test('automatic audience replies require a deliberate window, silence and eligible message', () => {
  const {scheduler,director,enqueue}=room()
  enqueue('one')
  director.event({type:'mode',value:'auto'})
  assert.equal(director.status().candidate,null)
  director.event({type:'speech-start',utterance:1})
  director.event({type:'viewer-window',value:true})
  assert.equal(director.status().candidate,null)
  director.event({type:'speech-end',utterance:1})
  const decision=director.status().candidate
  assert.equal(decision.source,'viewer')
  const turn=director.consume(decision.id)
  assert.equal(turn.input.id,'one')
  assert.equal(director.consume(decision.id),null)
  assert.equal(scheduler.queue.length,0)
})
test('audience window does not bypass manual mode, mute, cooldown or message expiry', () => {
  const r=room(); r.enqueue('one')
  r.director.event({type:'viewer-window',value:true})
  assert.equal(r.director.status().candidate,null)
  r.scheduler.setMuted(true)
  r.director.event({type:'mode',value:'auto'})
  assert.equal(r.director.status().candidate,null)
  r.scheduler.setMuted(false)
  const turn=r.director.consume(r.director.status().candidate.id)
  r.scheduler.finish(turn); r.enqueue('two')
  assert.equal(r.director.status().candidate,null)
  r.advance(20000)
  assert.equal(r.director.status().candidate,null)
  r.enqueue('three')
  assert.ok(r.director.status().candidate)
})
test('new host speech and topic change invalidate audience decisions', () => {
  const r=room(); r.enqueue('one')
  r.director.event({type:'mode',value:'auto'})
  const decision=r.director.event({type:'viewer-window',value:true}).candidate
  r.director.event({type:'speech-start',utterance:1})
  assert.equal(r.director.consume(decision.id),null)
  r.director.event({type:'speech-end',utterance:1})
  r.director.event({type:'topic-change'})
  assert.equal(r.director.status().viewerWindow,false)
  assert.equal(r.scheduler.queue.length,0)
})
test('changed audience selection cannot consume a stale message decision', () => {
  const r=room(); r.enqueue('one'); r.enqueue('two')
  r.director.event({type:'mode',value:'auto'})
  const candidate=r.director.event({type:'viewer-window',value:true}).candidate
  r.scheduler.selectViewer('manual','two')
  assert.equal(r.director.consume(candidate.id),null)
  const next=r.director.status().candidate
  assert.equal(r.director.consume(next.id).input.id,'two')
})
test('handover keeps priority over open audience window; trace has stable sequence IDs', () => {
  const r=room(); r.enqueue('one')
  r.director.event({type:'mode',value:'auto'}); r.director.event({type:'viewer-window',value:true})
  r.director.event({type:'speech-start',utterance:1})
  r.director.event({type:'transcript',utterance:1,text:'助播，你怎么看？',final:true})
  const candidate=r.director.event({type:'speech-end',utterance:1}).candidate
  assert.equal(candidate.intent,'handover')
  const trace=r.director.status().trace
  assert.equal(new Set(trace.map(x=>x.id)).size,trace.length)
  assert.equal(r.director.consume(candidate.id).input.source,'host')
})

async function serve(t,options) {
  const server=createApp({token:'',apiKey:'',...options})
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const base=`http://127.0.0.1:${server.address().port}`
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  return {post,get:path=>fetch(base+path)}
}
test('mock mode needs no key and cannot enter real model history',async t=>{
  const histories=[]
  async function* reply({history}) {histories.push(history);yield '真实接口测试替身'}
  const r=await serve(t,{apiKey:'test-only',reply})
  const mock=await r.post('/api/reply',{source:'host',engine:'mock',text:'你好'})
  assert.match(await mock.text(), /"engine":"mock"/)
  const real=await r.post('/api/reply',{source:'host',text:'继续'})
  await real.text()
  assert.deepEqual(histories[0],[])
  assert.equal((await r.post('/api/reply',{source:'host',text:'x',engine:'other'})).status,400)
  assert.equal((await r.post('/api/reply',{source:'host',text:'x',engine:'mock',delivery:'audio'})).status,400)
})
test('room assets load with a restrictive stage frame policy and missing key is local guidance',async t=>{
  const r=await serve(t,{})
  const page=await r.get('/')
  assert.match(page.headers.get('Content-Security-Policy'),/frame-src http:\/\/127.0.0.1:5173/)
  assert.match(await page.text(),/人工导演/)
  const script=await r.get('/client.mjs')
  assert.equal(script.status,200)
  assert.match(script.headers.get('Content-Type'),/javascript/)
  const response=await r.post('/api/reply',{source:'host',text:'你好'})
  assert.match(await response.text(),/\.env/)
})
test('queue selection is visible, bounded and rejects expired comments',async t=>{
  const r=await serve(t,{})
  await r.post('/api/danmaku',{id:'one',platform:'manual',userId:'viewer',text:'你好'})
  assert.equal((await r.post('/api/danmaku/select',{id:'one',platform:'manual'})).status,200)
  const state=await (await r.get('/api/status')).json()
  assert.equal(state.queue[0].selected,true)
  assert.equal(state.queue[0].text,'你好')
  assert.equal((await r.post('/api/danmaku/select',{id:'missing',platform:'manual'})).status,409)
  assert.equal((await r.post('/api/director/event',{type:'viewer-window',value:'true'})).status,400)
})
