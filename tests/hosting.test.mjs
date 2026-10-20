import test from 'node:test'
import assert from 'node:assert/strict'
import { Hosting } from '../apps/cohost/hosting.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Scene } from '../apps/cohost/scene.mjs'
import { SessionMemory } from '../apps/cohost/session-store.mjs'
import { parseParticipation, participationRequest } from '../apps/cohost/participation-model.mjs'
import { parseHostingClosing } from '../apps/cohost/hosting-closing.mjs'

const answer=(action='reply_program',extra={})=>({action,hostIntent:action.startsWith('reply_')?'spontaneous':'none',reason:'我来带大家玩一个接龙。',text:action.startsWith('reply_')?'给鲸鱼便利店起个名字，你们会选什么？':'',targetId:'',platform:'',revisitAfterSeconds:action.startsWith('reply_')?15:0,...extra})
function fixture(t,plan=async()=>answer(),options={}){
  let now=10000
  const scheduler=new Scheduler({now:()=>now}),director=new Director({scheduler,now:()=>now})
  const hosting=new Hosting({now:()=>now,continuous:false,...options}),scene=new Scene()
  director.event({type:'mode',value:'auto'})
  const p=new Participation({scheduler,director,scene,hosting,plan,observe:options.observe??(async()=>({choice:'consider_speaking',reason:'有具体内容可继续考虑。',idea:'从新的角度接着聊。'})),enabled:true,now:()=>now})
  t.after(()=>{p.close();director.close()})
  const advance=(ms=6001)=>{now+=ms;hosting.tick(scheduler)}
  const consume=()=>{const turn=director.consume(director.candidate.id);hosting.track(turn);turn.answer=turn.preparedReply;return turn}
  return {hosting,scheduler,director,p,advance,consume}
}
test('hosting starts without fake host input, advances only after playback, and bounds unattended speech',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return answer('reply_program',{revisitAfterSeconds:calls<3?15:0})})
  assert.equal(f.hosting.state,'off');await f.p.run();assert.equal(calls,0)
  f.hosting.start('鲸鱼便利店')
  for(let i=0;i<3;i++){
    await f.p.run();const turn=f.consume();assert.equal(turn.input.source,'program');assert.equal(f.director.utterance,null)
    turn.delivery='audio';f.scheduler.finish(turn);f.advance(12000)
    assert.equal(f.hosting.steps,i);await f.p.run();assert.equal(calls,i+1)
    assert.equal(f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started'}),true)
    assert.equal(f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length}),true)
    f.hosting.tick(f.scheduler);f.advance(15001)
  }
  assert.equal(f.hosting.steps,3);assert.equal(f.hosting.state,'waiting')
  for(let i=0;i<10;i++){f.advance(30000);await f.p.run()}
  assert.equal(calls,3);f.hosting.input();assert.equal(f.hosting.state,'observing');assert.equal(f.hosting.quiet,0)
})

test('finite review mode retains its explicit clock without any new input',async t=>{
  const seen=[]
  const f=fixture(t,async snapshot=>{seen.push(snapshot);return answer(seen.length===1?'wait':'reply_program',
    {hostingIntent:seen.length===1?'listen':'lead',revisitAfterSeconds:seen.length===1?30:0,reason:seen.length===1?'留半分钟给大家想想。':'留白结束，换个角度接着聊。'})},{continuous:false})
  f.hosting.start('日常小发现');await f.p.run()
  const started=seen[0].clock.nowMs
  for(let n=0;n<29;n++){f.advance(1000);f.p.notify();await f.p.run()}
  assert.equal(seen.length,1,'clock changes alone must not trigger model polling')
  f.advance(1000);await f.p.run()
  const next=seen[1]
  assert.equal(next.clock.nowMs-started,30000);assert.equal(next.clock.iso,new Date(started+30000).toISOString())
  assert.equal(next.clock.timeZone,'Asia/Shanghai');assert.equal(next.clock.localTime,'1970-01-01 08:00:40')
  assert.equal(next.hostOpportunity,false);assert.equal(next.latestHost,null);assert.deepEqual(next.eligibleViewers,[])
  assert.equal(next.programOpportunity,true);assert.equal(next.hosting.pauseElapsedMs,30000)
  assert.equal(next.hosting.quietMs,30000);assert.equal(next.hosting.wakeup.reason,'scheduled')
  assert.equal(next.hosting.wakeup.scheduledAt,started+30000)
  assert.equal(next.hosting.previousDecision.reason,'留半分钟给大家想想。')
  assert.equal(next.hosting.previousDecision.plannedWaitMs,30000);assert.ok(f.director.candidate)
})

test('continuous silent observations retain elapsed time without resetting the pause or invoking speech',async t=>{
  const seen=[],f=fixture(t,async()=>assert.fail('waiting observations must not invoke full generation'),{continuous:true,observe:async snapshot=>{seen.push(snapshot);return {choice:'wait',reason:'继续给大家留空间。',idea:''}}})
  f.hosting.start();await f.p.run();f.advance(30000);await f.p.run();f.advance(30000);await f.p.run()
  assert.equal(f.hosting.nextReviewAt,null)
  assert.equal(seen[2].hosting.quietMs,60000)
  assert.equal(seen[2].hosting.wakeup,null)
  assert.equal(seen[2].hosting.observation.choice,'wait')
  assert.equal(seen[2].clock.nowMs-seen[0].clock.nowMs,60000)
})

test('pause clock starts at actual playback completion, not generation or a later scheduler tick',async t=>{
  const closing=parseHostingClosing({kind:'closing',handoff:'audience',revisitAfterSeconds:30,reason:'留给观众回答。'})
  const seen=[],f=fixture(t,async snapshot=>{seen.push(snapshot);return answer('reply_program',{
    replyStream:{hostingClosingRequired:true,hostingClosing:closing,close(){}}})},{continuous:false})
  f.hosting.start();await f.p.run();const turn=f.consume();turn.delivery='audio';f.scheduler.finish(turn)
  f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started'})
  for(let n=0;n<6;n++){f.advance(10000);f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'progress',playedChars:n+1})}
  assert.equal(f.hosting.context(f.scheduler).pauseElapsedMs,null)
  f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length})
  const ended=f.scheduler.lastCompletedAt
  f.advance(250)
  assert.equal(f.hosting.nextReviewAt,ended+30000)
  assert.equal(f.hosting.context(f.scheduler).pauseElapsedMs,250)
  f.advance(29749);await f.p.run();assert.equal(seen.length,1)
  f.advance(1);await f.p.run()
  assert.equal(seen[1].hosting.audienceWaitMs,30000);assert.equal(seen[1].hosting.pauseElapsedMs,30000)
  assert.equal(seen[1].hosting.sincePlaybackMs,30000);assert.equal(seen[1].hosting.quietMs,30000)
  assert.equal(seen[1].hosting.withoutInputMs,90000)
})

test('a pending director choice is revoked by manual pause, stop and fresh input',async t=>{
  for(const cancel of ['pause','stop','input']){
    const f=fixture(t,async()=>answer('wait',{revisitAfterSeconds:15}),{continuous:true})
    f.hosting.start();await f.p.run();f.advance(15000)
    assert.equal(f.hosting.nextReviewAt,null)
    if(cancel==='pause')f.hosting.pause();else if(cancel==='stop')f.hosting.stop();else f.hosting.input()
    const context=f.hosting.context(f.scheduler)
    assert.equal(context.pauseElapsedMs,null)
    assert.equal(context.wakeup,null)
    assert.equal(context.opportunity,false)
  }
})
test('quiet review wait or failure does not keep polling the model',async t=>{
  for(const fail of [false,true]){
    let calls=0;const f=fixture(t,async()=>{calls++;if(fail)throw Error('offline');return answer('wait')})
    f.hosting.start();await f.p.run()
    assert.equal(f.hosting.state,fail?'paused':'waiting')
    for(let i=0;i<5;i++){f.advance(20000);await f.p.run()}
    assert.equal(calls,1)
  }
})
test('host speech cancels a quiet candidate and late decisions cannot overwrite new input',async t=>{
  let finish,closed=0;const f=fixture(t,()=>new Promise(resolve=>{finish=resolve}))
  f.hosting.start();const pending=f.p.run()
  f.director.event({type:'speech-start',utterance:1});f.p.invalidate()
  finish(answer('reply_program',{replyStream:{close(){closed++}}}));await pending
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.director.candidate,null);assert.equal(closed,1)
  assert.equal(f.hosting.state,'waiting')
  f.hosting.input();assert.equal(f.hosting.state,'observing')
})
test('expired and preempted quiet candidates release hosting instead of leaving a stuck running state',async t=>{
  for(const expiry of [true,false]){
    const f=fixture(t);f.hosting.start();await f.p.run()
    if(expiry){const id=f.director.candidate.id;f.advance(1600);assert.equal(f.director.consume(id),null)}
    else f.director.event({type:'speech-start',utterance:1})
    assert.equal(f.hosting.state,'waiting');f.hosting.input();assert.equal(f.hosting.state,'observing')
  }
})
test('audience input wins over a quiet opening and does not change saved viewer permissions',async t=>{
  let seen;const f=fixture(t,async snapshot=>{seen=snapshot;return answer('reply_viewer',{targetId:'1',platform:'manual'})})
  f.hosting.start();f.scheduler.enqueue({id:'1',platform:'manual',userId:'u',text:'开一家海底便利店怎么样',mentioned:true})
  await f.p.run();assert.equal(seen.viewerWindow,true);assert.equal(f.director.viewerWindow,false)
  assert.equal(f.consume().input.source,'viewer');assert.equal(f.scheduler.queue.length,0)
})
test('explicit pause cannot be undone by audience input, stage loss and incomplete delivery pause hosting',async t=>{
  const f=fixture(t);f.hosting.start();await f.p.run();const turn=f.consume()
  f.scheduler.interrupt('host_stop');f.hosting.tick(f.scheduler)
  assert.equal(f.hosting.state,'paused');f.hosting.input();assert.equal(f.hosting.state,'paused')
  f.hosting.resume();f.hosting.tick(f.scheduler,false);assert.equal(f.hosting.reason,'stage')
  assert.equal(f.hosting.steps,0);assert.equal(turn.controller.signal.aborted,true)
})
test('run limits, restart and stale candidates cannot produce extra speech',async t=>{
  const f=fixture(t);f.hosting.maxSteps=1;f.hosting.start();await f.p.run();const turn=f.consume()
  f.scheduler.finish(turn);f.hosting.tick(f.scheduler);assert.equal(f.hosting.state,'completed')
  assert.equal(f.hosting.resume(),false)
  assert.equal(new Hosting().state,'off')
  f.hosting.start();await f.p.run();const id=f.director.candidate.id;f.hosting.pause();assert.equal(f.director.consume(id),null)
  f.hosting.start();f.advance(600001);assert.equal(f.hosting.state,'completed')
})
test('program source survives memory without claiming a human said the activity',async t=>{
  const f=fixture(t);f.hosting.start('接龙');await f.p.run();const turn=f.consume()
  turn.input.engine='deepseek';turn.characterId='fish';turn.deliveryId='hosting-1';f.scheduler.finish(turn)
  const memory=new SessionMemory();memory.remember(turn,turn.answer,0)
  assert.equal(JSON.parse(memory.history('fish')[0].content).source,'program')
  const message={tool_calls:[{function:{name:'participate',arguments:JSON.stringify(answer())}}]}
  assert.equal(parseParticipation(message).action,'reply_program')
  assert.throws(()=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(answer('reply_program',{hostIntent:'invited'}))}}]}))
  const system=participationRequest({hosting:{state:'running'}},{model:'shared'}).messages[0].content
  assert.match(system,/你是直播的主角/);assert.match(system,/不要虚构观众回应/)
})

test('a connected conversation offers autonomy without a mode switch, but opening or pausing alone cannot speak',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return answer('wait')})
  f.advance(9000);await f.p.run();assert.equal(calls,0)
  f.hosting.observe();assert.equal(f.hosting.state,'observing');await f.p.run();assert.equal(calls,0)
  f.advance();await f.p.run();assert.equal(calls,1);assert.equal(f.hosting.state,'waiting')
  f.advance(30000);await f.p.run();assert.equal(calls,1)
  f.hosting.pause('stop');f.hosting.observe();f.hosting.input();assert.equal(f.hosting.state,'paused')
  f.hosting.stop();f.hosting.observe();assert.equal(f.hosting.state,'off');assert.equal(f.hosting.automatic,false)
})
test('model leadership and topic commit only after delivered speech and cannot override newer input',async t=>{
  for(const newerInput of [false,true]){
    const f=fixture(t,async()=>answer('reply_program',{hostingIntent:'lead',hostingTopic:'离谱发明评审会'}))
    f.hosting.observe();f.advance();await f.p.run();const turn=f.consume()
    assert.equal(turn.hostingIntent,'lead');assert.equal(f.hosting.topic,'')
    if(newerInput)f.hosting.input()
    f.scheduler.finish(turn);f.hosting.tick(f.scheduler)
    assert.equal(f.hosting.topic,newerInput?'':'离谱发明评审会')
    assert.equal(f.hosting.state,newerInput?'observing':'waiting');assert.equal(f.hosting.role,newerInput?'listen':'lead')
  }
})
test('model can end its own segment, and a human wait does not schedule a redundant quiet review',async t=>{
  const f=fixture(t,async()=>answer('reply_program',{hostingIntent:'listen',revisitAfterSeconds:0}))
  f.hosting.observe();f.advance();await f.p.run();const turn=f.consume();f.scheduler.finish(turn);f.hosting.tick(f.scheduler)
  assert.equal(f.hosting.state,'waiting')
  f.hosting.input();f.director.event({type:'speech-start',utterance:1});f.director.event({type:'transcript',utterance:1,text:'这个故事还差后半段，我接着讲。',final:true});f.director.event({type:'speech-end',utterance:1})
  f.p.plan=async()=>answer('wait');await f.p.run();assert.equal(f.hosting.state,'waiting')
  f.advance(10000);assert.equal(f.p.context().programOpportunity,false)
})
test('a completed segment stays quiet until a new input, while explicit stop keeps autonomy disabled',async t=>{
  const f=fixture(t);f.hosting.maxSteps=1;f.hosting.observe();f.advance();await f.p.run();const turn=f.consume()
  f.scheduler.finish(turn);f.hosting.tick(f.scheduler);assert.equal(f.hosting.state,'completed')
  f.advance(30000);assert.equal(f.p.context().programOpportunity,false)
  f.hosting.input();assert.equal(f.hosting.state,'observing');assert.equal(f.hosting.steps,0)
  f.hosting.stop();f.hosting.input();assert.equal(f.hosting.state,'off')
})
test('quiet reviews cannot offer answering an already consumed host question',()=>{
  const offered=snapshot=>participationRequest(snapshot,{model:'shared'}).tools[0].function.parameters.properties.action.enum
  assert.deepEqual(offered({programOpportunity:true,hostOpportunity:false,eligibleViewers:[],active:false}),['wait','reply_program'])
  assert.deepEqual(offered({programOpportunity:true,hostOpportunity:false,viewerWindow:true,eligibleViewers:[{id:'1'}],active:false}),['wait','reply_viewer','reply_program'])
  assert.deepEqual(offered({programOpportunity:true,hostOpportunity:true,eligibleViewers:[],active:true}),['wait','reply_host','stop'])
  assert.deepEqual(offered({programOpportunity:false,hostOpportunity:false,eligibleViewers:[],active:false}),['wait'])
})

test('hosting offers unmentioned chat and can reply twice to the same viewer without cohost cooldowns',async t=>{
  const offered=[]
  const f=fixture(t,async snapshot=>{offered.push(snapshot.eligibleViewers);return answer('reply_viewer',{targetId:snapshot.eligibleViewers[0].id,platform:'manual'})})
  f.hosting.start()
  for(const [id,text] of [['1','怎么好像就你一个人啊'],['2','主播呢']]) {
    f.scheduler.enqueue({id,platform:'manual',userId:'same',text})
    f.hosting.input();await f.p.run()
    const turn=f.consume();assert.equal(turn.input.id,id);f.scheduler.finish(turn);f.hosting.tick(f.scheduler)
    f.advance(3001)
  }
  assert.deepEqual(offered.map(x=>x[0].text),['怎么好像就你一个人啊','主播呢'])
  f.hosting.stop();f.scheduler.enqueue({id:'3',platform:'manual',userId:'same',text:'助播原来的限制',mentioned:true})
  assert.deepEqual(f.scheduler.eligibleViewers(),[],'cohost cooldowns still apply after leaving hosting')
})

test('hosting keeps chat through long playback and still enforces pause, mute, human speech and expiry',async t=>{
  const f=fixture(t)
  f.hosting.start();const speaking=f.scheduler.beginHost('一段长讲话');speaking.delivery='audio';speaking.playbackDeadline=Infinity
  f.scheduler.enqueue({id:'1',platform:'manual',userId:'u',text:'主播呢'})
  f.advance(45000);assert.equal(f.scheduler.queue.length,1);assert.deepEqual(f.scheduler.eligibleViewers(),[])
  f.scheduler.interrupt();assert.equal(f.scheduler.eligibleViewers().length,1)
  f.scheduler.setMuted(true);assert.equal(f.scheduler.eligibleViewers().length,0);f.scheduler.setMuted(false)
  f.scheduler.observeHostSpeaking(true);assert.equal(f.scheduler.eligibleViewers().length,0);f.scheduler.observeHostSpeaking(false)
  f.hosting.pause('stop');f.hosting.input();assert.equal(f.hosting.state,'paused');assert.equal(f.p.context().eligibleViewers.length,0)
  f.hosting.resume();f.scheduler.enqueue({id:'2',platform:'manual',userId:'u',text:'过期测试'})
  f.advance(90001);assert.equal(f.scheduler.eligibleViewers().length,0)
})

test('hosting may skip unrelated chat for a program turn, or wait without polling an unchanged audience',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return answer()})
  f.hosting.start();f.scheduler.enqueue({id:'1',platform:'manual',userId:'u',text:'刷个无关广告'})
  await f.p.run();assert.equal(f.consume().input.source,'program')
  f.scheduler.finish(f.scheduler.active);f.hosting.tick(f.scheduler);f.advance(15001)
  f.p.plan=async()=>{calls++;return answer('wait')};f.director.viewerWindow=true
  await f.p.run();assert.equal(f.hosting.state,'waiting')
  const waited=calls
  for(let i=0;i<4;i++){f.advance(4000);await f.p.run()}
  assert.equal(calls,waited)
  f.scheduler.enqueue({id:'2',platform:'manual',userId:'v',text:'新观众来啦'});f.hosting.input()
  await f.p.run();assert.equal(calls,waited+1)
})

test('model schedules one silent review, can change role, and can choose no further wakeup',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return answer('wait',{hostingIntent:calls===1?'support':'listen',revisitAfterSeconds:calls===1?30:0})})
 f.hosting.start();await f.p.run();assert.equal(f.hosting.role,'support');assert.equal(f.hosting.reason,'scheduled')
 f.advance(29999);await f.p.run();assert.equal(calls,1)
 f.advance(2);await f.p.run();assert.equal(calls,2);assert.equal(f.hosting.role,'listen');assert.equal(f.hosting.nextReviewAt,null)
 f.advance(120000);await f.p.run();assert.equal(calls,2)
})

test('wake timing begins after actual delivery and a newer input discards the old role and timer',async t=>{
 for(const newer of [false,true]) {
  const f=fixture(t,async()=>answer('reply_program',{hostingIntent:'support',revisitAfterSeconds:30}))
  f.hosting.start();await f.p.run();const turn=f.consume();turn.delivery='audio';f.scheduler.finish(turn)
  f.advance(5000);assert.equal(f.hosting.nextReviewAt,null)
  if(newer)f.hosting.input()
  f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started'})
  f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length});f.hosting.tick(f.scheduler)
  if(newer){assert.equal(f.hosting.role,'listen');assert.equal(f.hosting.nextReviewAt,null);continue}
  assert.equal(f.hosting.role,'support');assert.equal(f.hosting.reason,'scheduled')
  f.advance(29999);assert.equal(f.p.context().programOpportunity,false)
  f.advance(2);assert.equal(f.p.context().programOpportunity,true)
 }
})

test('manual controls, stage loss, mute and human speech revoke scheduled reviews',async t=>{
 for(const cancel of [f=>f.hosting.pause('manual'),f=>f.hosting.stop(),f=>f.hosting.tick(f.scheduler,false),f=>{f.scheduler.setMuted(true);f.hosting.tick(f.scheduler)},f=>f.hosting.cancelReview()]){
  let calls=0;const f=fixture(t,async()=>{calls++;return answer('wait',{revisitAfterSeconds:15})})
  f.hosting.start();await f.p.run();assert.notEqual(f.hosting.nextReviewAt,null)
  cancel(f);assert.equal(f.hosting.nextReviewAt,null);f.advance(120001);await f.p.run();assert.equal(calls,1)
 }
})

test('finite review budget also bounds a model that only schedules more silent reviews',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return answer('wait',{revisitAfterSeconds:15})})
 f.hosting.start();f.hosting.maxReviews=3
 for(let i=0;i<8;i++){await f.p.run();f.advance(15001)}
 assert.equal(calls,3);assert.equal(f.hosting.state,'completed');assert.equal(f.hosting.nextReviewAt,null)
 f.hosting.input();await f.p.run();assert.equal(calls,3);f.advance();await f.p.run();assert.equal(calls,4)
})

test('late wait cannot overwrite a new audience opportunity or restore a cancelled timer',async t=>{
 let finish;const f=fixture(t,()=>new Promise(r=>{finish=r}))
 f.hosting.start();const request=f.p.run()
 f.scheduler.enqueue({id:'new',platform:'manual',userId:'u',text:'这边有问题'});f.hosting.input()
 finish(answer('wait',{hostingIntent:'support',revisitAfterSeconds:90}));await request
 assert.equal(f.hosting.state,'observing');assert.equal(f.hosting.nextReviewAt,null);assert.equal(f.hosting.role,'listen')
})

test('optional invalid timing cannot grant a wakeup and role selection is parsed independently of speech',()=>{
 const parse=args=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(answer('wait',args))}}]})
 assert.equal(parse({hostingIntent:'support',revisitAfterSeconds:30}).hostingIntent,'support')
 for(const value of [-1,1,14,121,15.5,'30',null])assert.equal(parse({revisitAfterSeconds:value}).revisitAfterSeconds,undefined)
 assert.equal(parse({revisitAfterSeconds:0}).revisitAfterSeconds,0)
 const hosting=new Hosting({continuous:false});hosting.start();hosting.decide({hostingIntent:'lead',revisitAfterSeconds:1});assert.equal(hosting.nextReviewAt,null)
})

test('a viewer retained through a long speech is executable, not merely visible to the model',async t=>{
 const f=fixture(t,async snapshot=>answer('reply_viewer',{targetId:snapshot.eligibleViewers[0].id,platform:'manual'}))
 f.hosting.start();f.scheduler.enqueue({id:'old',platform:'manual',userId:'u',text:'主播呢'})
 const turn=f.scheduler.beginHost('长讲话');f.advance(45000);f.scheduler.finish(turn)
 await f.p.run();assert.equal(f.consume().input.id,'old')
})

test('the last permitted decision is not cancelled by a lifecycle tick before its speech starts',async t=>{
 let finish;const f=fixture(t,()=>new Promise(resolve=>{finish=resolve}))
 f.hosting.maxReviews=1;f.hosting.start();const pending=f.p.run();f.hosting.tick(f.scheduler)
 assert.equal(f.hosting.state,'observing')
 finish(answer('reply_program',{revisitAfterSeconds:30}));await pending;f.hosting.tick(f.scheduler)
 const turn=f.consume();assert.equal(turn.input.source,'program');f.scheduler.finish(turn);f.hosting.tick(f.scheduler)
 assert.equal(f.hosting.state,'completed');assert.equal(f.hosting.nextReviewAt,null)
})

test('a short continuation waits for full playback, then reviews without the former fifteen-second floor',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return answer(calls===1?'reply_program':'wait',
   {hostingPace:calls===1?'continue':'yield',revisitAfterSeconds:calls===1?2:0})})
 f.hosting.start();await f.p.run();const turn=f.consume()
 assert.equal(turn.hostingPace,'continue');turn.delivery='audio';f.scheduler.finish(turn)
 assert.equal(f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started'}),true)
 for(let i=0;i<3;i++){
   f.advance(10000);assert.equal(f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'progress',playedChars:i+1}),true)
   await f.p.run();assert.equal(calls,1);assert.equal(f.hosting.nextReviewAt,null)
 }
 f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length});f.hosting.tick(f.scheduler)
 assert.equal(f.hosting.context(f.scheduler).pace,'continue')
 f.advance(1999);await f.p.run();assert.equal(calls,1)
 f.advance(1);await f.p.run();assert.equal(calls,2);assert.equal(f.hosting.nextReviewAt,null)
 f.advance(120000);await f.p.run();assert.equal(calls,2,'a continuation is a review, not an obligation to speak')
})

test('yielding after a reply may leave five seconds, but silent decisions cannot fast-poll',async t=>{
 const f=fixture(t,async()=>answer('reply_program',{hostingPace:'yield',revisitAfterSeconds:5}))
 f.hosting.start();await f.p.run();const turn=f.consume();f.scheduler.finish(turn);f.hosting.tick(f.scheduler)
 f.advance(4999);assert.equal(f.p.context().programOpportunity,false)
 f.advance(1);assert.equal(f.p.context().programOpportunity,true)
 for(const action of ['wait','react'])for(const hostingPace of ['continue','yield']){
   const h=new Hosting({continuous:false});h.start();h.decide(answer(action,{hostingPace,revisitAfterSeconds:2}));assert.equal(h.nextReviewAt,null)
 }
})

test('short continuations remain revocable and do not bypass the unattended review budget',async t=>{
 for(const cancel of [f=>f.hosting.pause(),f=>f.hosting.stop(),f=>f.hosting.cancelReview(),f=>f.hosting.input(),
   f=>f.hosting.tick(f.scheduler,false),f=>{f.scheduler.setMuted(true);f.hosting.tick(f.scheduler)}]){
   const f=fixture(t,async()=>answer('reply_program',{hostingPace:'continue',revisitAfterSeconds:1}))
   f.hosting.start();await f.p.run();const turn=f.consume();f.scheduler.finish(turn);f.hosting.tick(f.scheduler)
   assert.notEqual(f.hosting.nextReviewAt,null);cancel(f);assert.equal(f.hosting.nextReviewAt,null)
   f.advance(1001);assert.equal(f.p.context().programOpportunity,false)
 }
 let calls=0;const f=fixture(t,async()=>{calls++;return answer('reply_program',{hostingPace:'continue',revisitAfterSeconds:1})})
 f.hosting.maxReviews=2;f.hosting.start()
 for(let i=0;i<2;i++){await f.p.run();const turn=f.consume();f.scheduler.finish(turn);f.hosting.tick(f.scheduler);f.advance(1000)}
 await f.p.run();assert.equal(calls,2);assert.equal(f.hosting.state,'completed')
})

test('pacing fields validate as a pair without rejecting otherwise valid speech',()=>{
 const parse=(action,extra)=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(answer(action,extra))}}]})
 for(const seconds of [1,2,10])assert.equal(parse('reply_program',{hostingPace:'continue',revisitAfterSeconds:seconds}).revisitAfterSeconds,seconds)
 for(const seconds of [-1,11,120,1.5,'2']){
   const result=parse('reply_program',{hostingPace:'continue',revisitAfterSeconds:seconds})
   assert.equal(result.revisitAfterSeconds,undefined);assert.ok(result.text)
 }
 for(const action of ['wait','react']){
   assert.equal(parse(action,{hostingPace:'continue',revisitAfterSeconds:2}).revisitAfterSeconds,undefined)
   assert.equal(parse(action,{hostingPace:'yield',revisitAfterSeconds:5}).revisitAfterSeconds,undefined)
 }
 assert.equal(parse('reply_program',{hostingPace:'yield',revisitAfterSeconds:5}).revisitAfterSeconds,5)
 assert.equal(parse('reply_program',{revisitAfterSeconds:30}).revisitAfterSeconds,30,'older plans remain compatible')
})

test('delivered final handoff replaces the opening draft and audience time excludes her own speech',async t=>{
 let closing=null
 const stream={hostingClosingRequired:true,get hostingClosing(){return closing},close(){}}
 const f=fixture(t,async()=>answer('reply_program',{hostingPace:'continue',revisitAfterSeconds:3,replyStream:stream}))
 f.hosting.start();await f.p.run();const turn=f.consume();turn.delivery='audio';f.scheduler.finish(turn)
 f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started'})
 closing=parseHostingClosing({kind:'closing',handoff:'audience',revisitAfterSeconds:30,reason:'交给观众。'})
 for(let i=0;i<3;i++){f.advance(10000);f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'progress',playedChars:i+1})}
 assert.equal(f.hosting.context(f.scheduler).audienceWaitMs,null);assert.equal(f.hosting.nextReviewAt,null)
 f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length});f.hosting.tick(f.scheduler)
 assert.equal(f.hosting.lastHandoff,'audience');assert.equal(f.hosting.pace,'yield')
 f.advance(3000);assert.equal(f.hosting.context(f.scheduler).audienceWaitMs,3000);assert.equal(f.p.context().programOpportunity,false)
 f.scheduler.lastCompletedAt=f.hosting.now() // An unrelated preview must not reset the audience clock.
 assert.equal(f.hosting.context(f.scheduler).audienceWaitMs,3000)
 f.advance(27000);assert.equal(f.p.context().programOpportunity,true)
 f.hosting.input();assert.equal(f.hosting.context(f.scheduler).audienceWaitMs,null)
})

test('missing closing cannot reuse an opening continue draft, while a final continue retains short pauses',async t=>{
 for(const handoff of [null,'listen','continue']){
  const final=handoff?parseHostingClosing({kind:'closing',handoff,revisitAfterSeconds:handoff==='continue'?2:0,reason:'收尾决定。'}):null
  const f=fixture(t,async()=>answer('reply_program',{hostingPace:'continue',revisitAfterSeconds:3,
    replyStream:{hostingClosingRequired:true,hostingClosing:final,close(){}}}))
  f.hosting.start();await f.p.run();const turn=f.consume();f.scheduler.finish(turn);f.hosting.tick(f.scheduler)
  f.advance(2000);assert.equal(f.p.context().programOpportunity,handoff==='continue')
  if(handoff!=='continue')assert.equal(f.hosting.nextReviewAt,null)
  if(handoff===null){assert.equal(f.hosting.state,'paused');assert.equal(f.hosting.reason,'error')}
 }
})

test('late final closing cannot survive newer input or an interrupted delivery',async t=>{
 for(const change of ['input','interrupt','pause','mute','stage']){
  const stream={hostingClosingRequired:true,hostingClosing:null,close(){}}
  const f=fixture(t,async()=>answer('reply_program',{replyStream:stream}))
  f.hosting.start();await f.p.run();const turn=f.consume()
  if(change==='input')f.hosting.input()
  if(change==='interrupt')f.scheduler.interrupt('host_stop')
  if(change==='pause')f.hosting.pause()
  if(change==='mute'){f.scheduler.setMuted(true);f.hosting.tick(f.scheduler)}
  if(change==='stage')f.hosting.tick(f.scheduler,false)
  stream.hostingClosing=parseHostingClosing({kind:'closing',handoff:'continue',revisitAfterSeconds:1,reason:'继续。'})
  f.scheduler.finish(turn);f.hosting.tick(f.scheduler)
  assert.equal(f.hosting.nextReviewAt,null);assert.equal(f.hosting.lastHandoff,null)
 }
})

test('continuous hosting runs beyond twelve turns and ten minutes without new input',async t=>{
 let calls=0
 const f=fixture(t,async()=>{calls++;return answer('reply_program',{hostingPace:'continue',revisitAfterSeconds:2})},{continuous:true})
 f.hosting.start()
 for(let i=0;i<25;i++){
   await f.p.run();const turn=f.consume();turn.delivery='audio';f.scheduler.finish(turn)
   f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started'})
   for(let j=0;j<5;j++){
     f.advance(5000)
     assert.equal(f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'progress',playedChars:j+1}),true)
   }
   f.scheduler.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length})
   f.hosting.tick(f.scheduler);f.advance(2000)
 }
 assert.equal(calls,25);assert.equal(f.hosting.steps,25)
 assert.equal(f.hosting.canObserve(f.scheduler),true)
 assert.equal(f.hosting.context(f.scheduler).reviewRemaining,null)
})

test('continuous observation starts only after interaction and can remain silent indefinitely',async t=>{
 let calls=0
 const f=fixture(t,async()=>assert.fail('no intent to speak'),{continuous:true,observe:async()=>{calls++;return {choice:'wait',reason:'安静也是当前选择。',idea:''}}})
 f.advance(60000);await f.p.run();assert.equal(calls,0,'opening the app alone is silent')
 f.hosting.observe();await f.p.run();assert.equal(calls,1)
 for(let i=0;i<60;i++){f.advance(1000);await f.p.run()}
 assert.equal(calls,61);assert.equal(f.hosting.nextReviewAt,null);assert.equal(f.director.candidate,null)
 for(const pause of [()=>f.hosting.pause('manual'),()=>f.hosting.pause('stop'),()=>f.hosting.stop()]){
   pause();f.hosting.input();f.hosting.observe();f.advance(120000);await f.p.run();assert.equal(calls,61)
 }
})

test('speech with no transcript takes priority and observation resumes when the floor is free',async t=>{
 let calls=0
 const f=fixture(t,async()=>{calls++;return answer('wait')},{continuous:true})
 f.hosting.start();await f.p.run();f.advance(29000)
 f.hosting.cancelReview();f.scheduler.observeHostSpeaking(true)
 f.advance(60000);await f.p.run();assert.equal(calls,1)
 f.scheduler.observeHostSpeaking(false);f.hosting.tick(f.scheduler)
 await f.p.run();assert.equal(calls,2)
})

test('transport failures back off independently of speech decisions and stop after three retries',async t=>{
 const f=fixture(t,async()=>{throw Error('offline')},{continuous:true})
 f.hosting.start()
 for(const delay of [30000,60000,120000]){
   await f.p.run()
   assert.equal(f.hosting.reason,'retry');assert.equal(f.hosting.observationRetryAt-f.hosting.now(),delay)
   assert.equal(f.hosting.nextReviewAt,null)
   f.advance(delay-1);assert.equal(f.p.context().programOpportunity,false);f.advance(1)
 }
 await f.p.run()
 assert.equal(f.hosting.state,'paused');assert.equal(f.hosting.reason,'error');assert.equal(f.hosting.nextReviewAt,null)
 f.hosting.resume();f.hosting.failed('credentials');assert.equal(f.hosting.state,'paused')
})

test('a cancelled continuous retry never overrides newer controls',async t=>{
 for(const cancel of [f=>f.hosting.pause('manual'),f=>f.hosting.stop(),f=>f.hosting.tick(f.scheduler,false),f=>{f.scheduler.setMuted(true);f.hosting.tick(f.scheduler)}]){
   const f=fixture(t,async()=>{throw Error('offline')},{continuous:true})
   f.hosting.start();await f.p.run();assert.equal(f.hosting.reason,'retry')
   cancel(f);f.advance(180000);assert.equal(f.p.context().programOpportunity,false);assert.equal(f.hosting.nextReviewAt,null)
 }
})

test('host delegation can restore hosting, but viewers, old host input and stop decisions cannot',async t=>{
 for(const source of ['host','viewer','old','stop','stale']){
   const f=fixture(t,async()=>answer('wait',{hostingControl:'start'}),{continuous:true})
   f.hosting.start();f.hosting.pause('manual')
   f.director.event({type:'speech-start',utterance:1})
   f.director.event({type:'transcript',utterance:1,text:'你先播着，我去忙点别的',final:true})
   f.director.event({type:'speech-end',utterance:1})
   const snapshot=f.p.context()
   if(source==='viewer')snapshot.hostOpportunity=false
   if(source==='old')f.advance(7000)
   if(source==='stale')f.hosting.stop()
   f.p.apply(answer(source==='stop'?'stop':'wait',{hostingControl:'start'}),snapshot,1)
   if(source==='host'){assert.equal(f.hosting.automatic,true);assert.equal(f.hosting.state,'waiting');assert.equal(f.hosting.reason,'observing');assert.equal(f.hosting.nextReviewAt,null)}
   else assert.ok(['paused','off'].includes(f.hosting.state),source)
 }
})

test('control revision tolerates runtime updates but rejects commands from before a human control',()=>{
 const h=new Hosting();const before=h.revision;h.observe();h.input();h.wait()
 assert.equal(h.acceptsControl(before),true)
 h.pause('stop');assert.equal(h.acceptsControl(before),false)
 const paused=h.revision;h.resume();assert.equal(h.acceptsControl(paused),false)
 assert.equal(h.acceptsControl(h.revision),true)
 for(const bad of [undefined,-1,0.1,'1',h.revision+1])assert.equal(h.acceptsControl(bad),false)
})

test('delegation control is parsed and offered only for a current final host opportunity',()=>{
 const parse=args=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(answer('wait',args))}}]})
 assert.equal(parse({hostingControl:'start'}).hostingControl,'start')
 assert.equal(parse({hostingControl:'stop'}).hostingControl,undefined)
 for(const hostOpportunity of [false,true]){
   const req=participationRequest({hostOpportunity,hosting:{state:'paused',continuous:true}},{model:'fixture'})
   assert.equal(Boolean(req.tools[0].function.parameters.properties.hostingControl),hostOpportunity)
 }
})

test('misclassified quotations, hypotheticals and negations cannot start hosting',async t=>{
 for(const text of ['他说“你先播着，我去忙点别的”，这句话是什么意思？','如果我让你自己主持，你会聊什么？','别开启自主模式，等我说完']){
   const f=fixture(t,async()=>answer('wait',{hostingControl:'start'}),{continuous:true})
   f.hosting.stop()
   for(const event of [{type:'speech-start',utterance:1},{type:'transcript',utterance:1,text,final:true},{type:'speech-end',utterance:1}])f.director.event(event)
   await f.p.run();assert.equal(f.hosting.state,'off');assert.equal(f.hosting.automatic,false)
 }
})

test('explicit semantic pause prevents future silence wakeups even without active audio',async t=>{
 const f=fixture(t,async()=>answer('wait',{hostingControl:'pause'}),{continuous:true})
 f.hosting.start()
 for(const event of [{type:'speech-start',utterance:1},{type:'transcript',utterance:1,text:'别开启自主模式，等我叫你',final:true},{type:'speech-end',utterance:1}])f.director.event(event)
 await f.p.run();f.advance(600000);assert.equal(f.hosting.state,'off');assert.equal(f.hosting.automatic,false)
 assert.equal(f.p.context().programOpportunity,false)
})
