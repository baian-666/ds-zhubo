import test from 'node:test'
import assert from 'node:assert/strict'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Scene } from '../apps/cohost/scene.mjs'
import { streamingParticipationRequest } from '../apps/cohost/participation-stream.mjs'

function fixture(t,plan) {
  const scheduler=new Scheduler(),director=new Director({scheduler})
  director.event({type:'mode',value:'auto'})
  const turn=scheduler.begin({source:'host',text:'请继续讲'})
  turn.answer='猫喜欢纸箱。它们也喜欢高处。';turn.playedChars=6
  const participation=new Participation({scheduler,director,scene:new Scene(),enabled:true,plan})
  t.after(()=>participation.close())
  director.event({type:'speech-start',utterance:1})
  return {scheduler,director,turn,participation}
}
const verdict=intent=>({action:'wait',hostIntent:'none',reason:'判断插话',text:'',targetId:'',platform:'',floorIntent:intent})

test('two-character partials receive semantic review early; a one-character fragment grants no permit',async t=>{
  const seen=[]
  const f=fixture(t,async snapshot=>{seen.push(snapshot.latestHost.text);return verdict('uncertain')})
  f.director.event({type:'speech-progress',utterance:1,text:'我',confirmed:''})
  assert.equal(f.participation.floorOffer(),null)
  f.director.event({type:'speech-progress',utterance:1,text:'我想',confirmed:''})
  await f.participation.run()
  assert.deepEqual(seen,['我想'])
  assert.equal(f.turn.floorReview.intent,'uncertain','early review must not imply permission to speak over the host')
})

test('a meaningful phrase supersedes only the early fragment review and late permission cannot revive it',async t=>{
  const calls=[]
  const f=fixture(t,(snapshot,{signal})=>new Promise(resolve=>calls.push({text:snapshot.latestHost.text,signal,resolve})))
  f.director.event({type:'speech-progress',utterance:1,text:'文对',confirmed:''})
  const first=f.participation.run()
  await new Promise(resolve=>setImmediate(resolve))
  f.director.event({type:'speech-progress',utterance:1,text:'文对对对',confirmed:''});f.participation.notify()
  assert.equal(calls[0].signal.aborted,true)
  await first
  clearTimeout(f.participation.timer);f.participation.timer=null
  const second=f.participation.run();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(calls[1].text,'文对对对')
  f.director.event({type:'speech-progress',utterance:1,text:'文对对对你继续',confirmed:''});f.participation.notify()
  assert.equal(calls[1].signal.aborted,false,'later extensions must not repeatedly restart useful reviews')
  calls[0].resolve(verdict('takeover'));calls[1].resolve(verdict('backchannel'));await second
  assert.equal(f.turn.floorReview.intent,'backchannel')
  assert.equal(f.turn.floorReview.text,'文对对对')
})

test('a delayed acknowledgment review survives only a bounded acknowledgment suffix on the same input and output',async t=>{
  for(const [intent,latest,accepted] of [
    ['backchannel','文，对对对，你继续说',true],
    ['backchannel','文，对对对，你继续说，我',true],
    ['backchannel','文，对对对，不过我还没说完',false],
    ['backchannel','不是，对对对，你继续说',false],
    ['takeover','文，对对对，你继续说',false],
  ]) {
    let resolve
    const f=fixture(t,()=>new Promise(done=>{resolve=done}))
    f.director.event({type:'speech-progress',utterance:1,text:'文，对对对',confirmed:''})
    const pending=f.participation.run()
    await new Promise(done=>setImmediate(done))
    f.director.event({type:'speech-progress',utterance:1,text:latest,confirmed:''})
    resolve(verdict(intent));await pending
    assert.equal(Boolean(f.turn.floorReview),accepted,`${intent}: ${latest}`)
    if(accepted)assert.equal(f.turn.floorReview.text,'文，对对对')
  }
})

test('floor review sees unplayed content explicitly and cannot generate another reply', async t=>{
  let snapshot
  const f=fixture(t,async input=>{snapshot=input;return verdict('takeover')})
  f.director.event({type:'speech-progress',utterance:1,text:'先听我把故事讲完',confirmed:''})
  await f.participation.run()
  assert.equal(snapshot.floorOpportunity,true)
  assert.equal(snapshot.hostOpportunity,false)
  assert.equal(snapshot.speaking.planned,'它们也喜欢高处。')
  assert.equal(f.turn.floorReview.intent,'takeover')
  assert.equal(f.scheduler.active.id,f.turn.id)
  const request=streamingParticipationRequest(snapshot,{model:'test'})
  const schema=request.tools[0].function.parameters.properties.records.items
  assert.deepEqual(schema.properties.kind.enum,['floor'])
  assert.deepEqual(schema.properties.intent.enum,['backchannel','takeover','uncertain'])
  assert.equal(schema.properties.action,undefined)
  assert.equal(request.tools[0].function.parameters.properties.records.maxItems,1)
})

test('new ASR evidence or a replaced output rejects a late permission to continue', async t=>{
  let resolve
  const f=fixture(t,()=>new Promise(done=>{resolve=done}))
  f.director.event({type:'speech-progress',utterance:1,text:'我明白你的意思',confirmed:''})
  const pending=f.participation.run()
  await new Promise(done=>setImmediate(done))
  f.director.event({type:'speech-progress',utterance:1,text:'我明白你的意思但是先别讲了',confirmed:''})
  resolve(verdict('backchannel'));await pending
  assert.equal(f.turn.floorReview,undefined)
  assert.equal(f.director.candidate,null)
})

test('a spoken acknowledgment longer than the old duration gate keeps its current answer', t=>{
  const f=fixture(t,async()=>{throw Error('No model required for an unambiguous acknowledgment')})
  f.director.utterance.startedAt-=2000
  f.director.event({type:'transcript',utterance:1,text:'嗯，对对，你继续说，我在听。',final:true})
  f.director.event({type:'speech-end',utterance:1})
  assert.equal(f.director.intent,'backchannel')
  assert.equal(f.scheduler.active.id,f.turn.id)
  assert.equal(f.participation.context().hostOpportunity,false)
})

test('finalizing identical text preserves a compact review and handles the acknowledgment once',async t=>{
  let resolve
  const f=fixture(t,()=>new Promise(done=>{resolve=done}))
  const text='文对对对你继续说我再听'
  f.director.event({type:'speech-progress',utterance:1,text,confirmed:''})
  const pending=f.participation.run();await new Promise(done=>setImmediate(done))
  const job=f.participation.job
  f.director.event({type:'transcript',utterance:1,text,final:true})
  f.participation.invalidate({preserveFloor:true})
  f.director.event({type:'speech-end',utterance:1});f.participation.notify()
  assert.equal(job.controller.signal.aborted,false)
  resolve(verdict('backchannel'));await pending
  assert.equal(f.turn.floorReview.intent,'backchannel')
  assert.equal(f.participation.context().hostOpportunity,false)
  assert.equal(f.participation.floorOffer(),null)
  assert.equal(f.scheduler.active.id,f.turn.id)
})

test('changed final text gets a fresh compact review; old acknowledgment cannot grant permission',async t=>{
  const calls=[]
  const f=fixture(t,(snapshot,{signal})=>new Promise(resolve=>calls.push({snapshot,signal,resolve})))
  f.director.event({type:'speech-progress',utterance:1,text:'文对对对你继续说我再',confirmed:''})
  const pending=f.participation.run();await new Promise(done=>setImmediate(done))
  f.director.event({type:'transcript',utterance:1,text:'文对对对不过我想补充一个问题',final:true})
  f.participation.invalidate({preserveFloor:true})
  f.director.event({type:'speech-end',utterance:1})
  assert.equal(calls[0].signal.aborted,true)
  await pending
  clearTimeout(f.participation.timer);f.participation.timer=null
  const fresh=f.participation.run();await new Promise(done=>setImmediate(done))
  assert.equal(calls[1].snapshot.floorOpportunity,true)
  assert.equal(calls[1].snapshot.latestHost.final,true)
  calls[0].resolve(verdict('backchannel'))
  calls[1].resolve(verdict('takeover'));await fresh
  assert.equal(f.turn.floorReview.intent,'takeover')
  assert.equal(f.participation.context().hostOpportunity,true)
})

test('final explicit stop never preserves an in-flight acknowledgment',async t=>{
  let resolve
  const f=fixture(t,()=>new Promise(done=>{resolve=done}))
  f.director.event({type:'speech-progress',utterance:1,text:'文对对对',confirmed:''})
  const pending=f.participation.run();await new Promise(done=>setImmediate(done))
  f.director.event({type:'transcript',utterance:1,text:'先别说了',final:true})
  f.participation.invalidate({clearThought:true})
  resolve(verdict('backchannel'));await pending
  assert.equal(f.turn.floorReview,undefined)
  assert.equal(f.scheduler.active,null)
})
