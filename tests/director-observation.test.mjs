import test from 'node:test'
import assert from 'node:assert/strict'
import { observationRequest, observeDirector } from '../apps/cohost/director-observation.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Hosting } from '../apps/cohost/hosting.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scene } from '../apps/cohost/scene.mjs'
import { streamingParticipationRequest } from '../apps/cohost/participation-stream.mjs'
import { parseHostingClosing } from '../apps/cohost/hosting-closing.mjs'

function fixture(t,observe,plan=async()=>({action:'wait',hostIntent:'none',reason:'重新考虑后仍选择安静。',text:''})){
  let now=10000
  const scheduler=new Scheduler({now:()=>now}),director=new Director({scheduler,now:()=>now}),hosting=new Hosting({now:()=>now})
  const p=new Participation({scheduler,director,hosting,scene:new Scene(),observe,plan,enabled:true,now:()=>now})
  director.event({type:'mode',value:'auto'});hosting.start('日常的小发现')
  t.after(()=>{p.close();director.close()})
  return {p,hosting,scheduler,director,advance:ms=>{now+=ms;hosting.tick(scheduler)}}
}
const waiting={choice:'wait',reason:'留空间给别人，此刻没有要说的内容。',idea:''}
const ready={choice:'consider_speaking',reason:'想到了相关的新角度。',idea:'从街道声音的变化聊起。'}

test('continuous monitoring can remain silent for a minute and never has a speech deadline',async t=>{
  const seen=[],f=fixture(t,async snapshot=>{seen.push(snapshot);return waiting},async()=>assert.fail('no speech generation'))
  for(let i=0;i<61;i++){await f.p.run();f.advance(1000)}
  assert.equal(seen.length,61);assert.equal(f.director.candidate,null)
  assert.equal(f.hosting.nextReviewAt,null);assert.equal(f.hosting.observations,61)
  assert.equal(seen[60].hosting.quietMs,60000)
  assert.equal(seen[60].clock.nowMs-seen[0].clock.nowMs,60000)
  assert.equal(f.director.trace.some(entry=>entry.reason==='participation_wait'),false,'silent samples must not flood chat or persistence')
})

test('an observation expresses intent, while the full director can still choose silence',async t=>{
  let calls=0
  const f=fixture(t,async()=>ready,async snapshot=>{calls++;assert.equal(snapshot.hosting.observation.idea,ready.idea);return {action:'wait',hostIntent:'none',reason:'这个角度现在不急着说。',text:''}})
  await f.p.run();assert.equal(calls,1);assert.equal(f.director.candidate,null)
  assert.equal(f.hosting.nextReviewAt,null)
})

test('only one observation runs at a time and late intent cannot survive human control',async t=>{
  for(const change of ['pause','input','mute','close']){
    let finish,calls=0
    const f=fixture(t,async()=>{calls++;return new Promise(resolve=>{finish=resolve})},async()=>assert.fail('obsolete intent'))
    const pending=f.p.run();await f.p.run();assert.equal(calls,1)
    if(change==='pause')f.hosting.pause()
    if(change==='input'){f.director.event({type:'speech-start',utterance:1});f.hosting.input()}
    if(change==='mute')f.scheduler.setMuted(true)
    if(change==='close')f.p.close()
    finish(ready);await pending
    assert.equal(f.director.candidate,null);assert.equal(f.hosting.programReady,false)
  }
})

test('continuous requests expose no delayed speech parameter and discard old timing fields',()=>{
  const snapshot={hosting:{state:'observing',continuous:true},programOpportunity:true}
  const request=streamingParticipationRequest(snapshot,{model:'test'})
  for(const schema of request.tools[0].function.parameters.properties.records.items.anyOf){
    assert.equal(schema.properties.revisitAfterSeconds,undefined)
  }
  assert.doesNotMatch(request.messages[0].content,/安静30秒|几秒后再观察|选1～10秒/)
  const clocked=parseHostingClosing({kind:'closing',handoff:'audience',reason:'留空间给大家。',revisitAfterSeconds:30},{continuous:true})
  assert.equal(clocked.revisitAfterSeconds,undefined)
  const plain=parseHostingClosing({kind:'closing',handoff:'listen',reason:'搭档先说。'},{continuous:true})
  assert.equal(plain.handoff,'listen')
  const h=new Hosting();h.start();h.decide({action:'wait',revisitAfterSeconds:30});assert.equal(h.nextReviewAt,null)
})

test('compact observation has no speech/tool side effects and validates provider results',async()=>{
  const request=observationRequest({clock:{nowMs:1000},scene:Array.from({length:20},()=>({role:'host',text:'x'.repeat(1000)}))},{model:'test'})
  assert.equal(request.tools[0].function.name,'observe');assert.ok(request.messages[1].content.length<2200)
  const input=JSON.parse(request.messages[1].content)
  assert.equal(input.audioPlaying,false);assert.equal(input.active,undefined)
  const fetchImpl=async()=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{function:{name:'observe',arguments:JSON.stringify(waiting)}}]}}]})
  assert.deepEqual(await observeDirector({}, {fetchImpl}),waiting)
  await assert.rejects(observeDirector({}, {fetchImpl:async()=>Response.json({choices:[{message:{tool_calls:[{function:{name:'observe',arguments:'{"choice":"speak_now","reason":"force","idea":""}'}}]}}]})}),/arguments/)
  await assert.rejects(observeDirector({}, {fetchImpl:async()=>new Response('secret diagnostics',{status:401})}),/credentials/)
  const empty={...ready,idea:' '}
  await assert.rejects(observeDirector({}, {fetchImpl:async()=>Response.json({choices:[{message:{tool_calls:[{function:{name:'observe',arguments:JSON.stringify(empty)}}]}}]})}),/arguments/)
  const h=new Hosting();h.start();assert.equal(h.acceptObservation(empty,h.revision),false);assert.equal(h.programReady,false)
})
