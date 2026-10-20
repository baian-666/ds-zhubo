import test from 'node:test'
import assert from 'node:assert/strict'
import {LiveListening} from '../apps/cohost/live-listening.mjs'
import {Director} from '../apps/cohost/director.mjs'
import {Scheduler} from '../apps/cohost/scheduler.mjs'
import {Participation} from '../apps/cohost/participation.mjs'
import {Scene} from '../apps/cohost/scene.mjs'
import {participationRequest} from '../apps/cohost/participation-model.mjs'
import {listeningTailMs} from '../packages/cohost-contracts/listening-tail.ts'

test('a listening tail is bounded by measured audio, never by text length',()=>{
  assert.equal(listeningTailMs(620,150),150)
  for(const [duration,remaining] of [[701,150],[620,181],[620,0],[620,-1],[100,150],[NaN,150],[620,Infinity]])
    assert.equal(listeningTailMs(duration,remaining),0)
})

test('only an already playing short reaction can finish its measured tail; renewal and manual stop cannot extend it',async t=>{
  const f=fixture(t);f.progress();await f.p.run();f.pause(true)
  const turn=f.d.consume(f.d.candidate.id)
  turn.answer=turn.preparedReply;turn.delivery='audio';turn.generationDone=true
  turn.preparedSpeech={ready:true,durationMs:620}
  assert.equal(f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started',playedChars:0}),true)
  const tail={turn:turn.id,audioId:turn.audioId,remainingMs:150}
  f.d.event({type:'speech-start',utterance:2,listeningTail:tail})
  assert.equal(f.s.active,turn);assert.equal(f.d.canContinueListening(),true)
  f.advance(120)
  f.d.event({type:'speech-pause',utterance:2,paused:false,listeningTail:tail})
  f.advance(61)
  assert.equal(f.d.canContinueListening(),false,'later frames cannot renew the original deadline')
  f.d.event({type:'interrupt'})
  assert.equal(f.s.active,null)
})

test('completed listening audio can acknowledge its end within the fixed tail cap',async t=>{
  const f=fixture(t);f.progress();await f.p.run();f.pause(true)
  const turn=f.d.consume(f.d.candidate.id)
  turn.answer=turn.preparedReply;turn.delivery='audio';turn.generationDone=true
  turn.preparedSpeech={ready:true,durationMs:620}
  f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started',playedChars:0})
  f.d.event({type:'speech-start',utterance:2,listeningTail:{turn:turn.id,audioId:turn.audioId,remainingMs:15}})
  f.advance(40)
  assert.equal(f.d.canContinueListening(),true,'the measured audio ended before its receipt arrived')
  assert.equal(f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length}),true)
  assert.equal(f.s.active,null)
})

test('unstarted, long or mismatched audio cannot claim a listening tail',async t=>{
  for(const mode of ['waiting','long','wrong-turn','unprepared']) {
    const f=fixture(t);f.progress();await f.p.run();f.pause(true)
    const turn=f.d.consume(f.d.candidate.id)
    turn.answer=turn.preparedReply;turn.delivery='audio';turn.generationDone=true
    turn.preparedSpeech={ready:mode!=='unprepared',durationMs:mode==='long'?900:620}
    if(mode!=='waiting')f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started',playedChars:0})
    f.d.event({type:'speech-pause',utterance:1,paused:false,listeningTail:{turn:turn.id+(mode==='wrong-turn'?1:0),audioId:turn.audioId,remainingMs:150}})
    assert.equal(f.s.active,null,mode)
  }
})

const text='我家的猫把跑步机当成猫窝了。'
const answer={action:'reply_host',hostIntent:'spontaneous',text:'升级了。',reason:'我接住这个笑点。'}
function fixture(t,plan=async()=>answer) {
  let time=10000
  const now=()=>time,s=new Scheduler({now}),d=new Director({scheduler:s,now}),scene=new Scene()
  const p=new Participation({director:d,scheduler:s,scene,plan,enabled:true,now,debounceMs:10000})
  t.after(()=>{p.close();d.close()})
  d.onTranscript=({text,utterance})=>scene.host(text,utterance)
  const event=body=>d.event({utterance:1,...body})
  event({type:'mode',value:'auto'});event({type:'speech-start'})
  const progress=(value=text,confirmed=value)=>event({type:'speech-progress',text:value,confirmed})
  const pause=value=>event({type:'speech-pause',paused:value})
  const final=value=>{event({type:'transcript',text:value,final:true});event({type:'speech-end'})}
  return {s,d,p,scene,event,progress,pause,final,advance:ms=>time+=ms}
}

test('plans a short response during speech, waits for a pause, and accepts playback before final ASR',async t=>{
  const snapshots=[],f=fixture(t,async snapshot=>{snapshots.push(snapshot);return answer})
  f.progress();await f.p.run()
  assert.equal(snapshots.length,1);assert.equal(snapshots[0].hostSpeaking,true)
  assert.equal(snapshots[0].listeningOpportunity,true)
  assert.equal(f.scene.entries.length,0,'preview is not a final chat message')
  const id=f.d.candidate.id
  assert.equal(f.d.consume(id),null)
  assert.equal(f.d.candidate.id,id,'waiting does not discard the prepared answer')
  f.pause(true)
  const turn=f.d.consume(id)
  assert.ok(turn);assert.equal(turn.listening.utterance,1)
  turn.answer=turn.preparedReply;turn.delivery='audio';turn.generationDone=true
  assert.equal(f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started',playedChars:0}),true)
  assert.equal(f.s.hostSpeaking,true,'a micro-pause does not end the host turn')
  f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length})
  f.final(text);await f.p.run()
  assert.equal(snapshots.length,1,'the final transcript must not cause a duplicate response')
  assert.equal(f.scene.entries.length,1)
})

test('resuming speech cancels early synthesis and preserves the final opportunity if nothing played',async t=>{
  const f=fixture(t);f.progress();await f.p.run();f.pause(true)
  const turn=f.d.consume(f.d.candidate.id)
  f.pause(false)
  assert.equal(turn.controller.signal.aborted,true);assert.equal(f.s.active,null)
  f.final(text)
  assert.equal(f.p.context().hostOpportunity,true)
})

test('changed or corrected ASR invalidates early results and never cancels an ordinary answer',async t=>{
  let resolve
  const f=fixture(t,()=>new Promise(done=>{resolve=done}))
  f.progress();const pending=f.p.run()
  await new Promise(done=>setImmediate(done))
  f.progress('刚才说错了，那不是我的猫。')
  resolve(answer);await pending
  assert.equal(f.d.candidate,null)
  f.s.observeHostSpeaking(false)
  const ordinary=f.s.beginHost('普通回答')
  f.event({type:'speech-start',utterance:2})
  f.event({type:'speech-pause',utterance:2,paused:false})
  assert.equal(ordinary.controller.signal.aborted,false)
})

test('a ready response survives the identical final while different finals and controls invalidate it',async t=>{
  const f=fixture(t);f.progress();await f.p.run()
  const id=f.d.candidate.id
  f.final(text)
  assert.equal(f.d.candidate.id,id)
  assert.ok(f.d.consume(id))
  const g=fixture(t);g.progress();await g.p.run();g.final('等一下，先听我说。')
  assert.equal(g.d.candidate,null);assert.equal(g.d.intent,'stop')
})

test('a prepared question survives its final invitation tail and an audible fragment is not retried',async t=>{
  const f=fixture(t)
  const question='小鲸鱼，你觉得它会给我发工资吗？'
  f.progress(question);await f.p.run()
  const id=f.d.candidate.id
  f.final(question+'你说说看。')
  assert.equal(f.d.candidate.id,id)
  const turn=f.d.consume(id)
  turn.answer=turn.preparedReply;turn.delivery='audio';turn.generationDone=true
  assert.equal(f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started',playedChars:0}),true)
  f.s.interrupt('host_resumed')
  assert.equal(f.d.listening.answered,question,'started audio cannot be treated as an unheard preparation')
  assert.equal(f.p.context().hostOpportunity,true,'additional final content still gets a normal decision')
})

test('a short reaction does not consume a question added later in the same utterance',async t=>{
  const f=fixture(t);f.progress();await f.p.run();f.pause(true)
  const turn=f.d.consume(f.d.candidate.id)
  turn.answer=turn.preparedReply;f.s.finish(turn)
  f.final(text+'你觉得我该怎么办？')
  assert.equal(f.p.context().hostOpportunity,true)
})

test('stale pause leases, manual mode, mute and long drafts cannot start early playback',async t=>{
  const f=fixture(t);f.progress();await f.p.run();f.pause(true);f.advance(701)
  assert.equal(f.d.consume(f.d.candidate.id),null)
  f.event({type:'mode',value:'manual'});assert.equal(f.d.candidate,null)
  const g=fixture(t,async()=>({...answer,text:'很长的回答'.repeat(10)}));g.progress();await g.p.run()
  assert.equal(g.d.candidate,null)
  const h=fixture(t);h.s.setMuted(true);h.progress();await h.p.run();assert.equal(h.d.candidate,null)
})

test('unconfirmed text requires stable evidence and repeated or fast updates are bounded',()=>{
  let time=0;const live=new LiveListening({now:()=>time})
  live.update('小鲸');assert.equal(live.offer(),null)
  time=100;live.update(text)
  time=700;assert.equal(live.offer().text,text)
  live.review(text);assert.equal(live.offer(),null)
  live.update(text+'真是的');time=1000;assert.equal(live.offer(),null)
  time=2600;assert.equal(live.offer(),null,'the same stable clause is not reviewed for each growing tail')
  live.update(text+'真是的。',text+'真是的。')
  assert.equal(live.offer().text,text+'真是的。')
  live.update(text+'不过我说错了')
  assert.equal(live.relevant(text),false,'correction tails withdraw the previous opportunity')
  assert.equal(live.sameContent('一共1.5万元。','一共15万元。'),false)
})

test('ordinary elaboration keeps a prepared clause useful while corrections retire it',async t=>{
  let resolve
  const f=fixture(t,()=>new Promise(done=>{resolve=done}))
  f.progress(text+'然后它还',text)
  const pending=f.p.run();await new Promise(done=>setImmediate(done))
  f.progress(text+'然后它还朝我叫',text)
  resolve(answer);await pending
  assert.equal(f.d.candidate?.text,text)
  f.pause(true)
  const turn=f.d.consume(f.d.candidate.id)
  assert.ok(turn,'a paragraph does not need to finish before a short response can start')
  f.progress(text+'然后它还朝我叫，接着又发生了一件事。')
  assert.equal(turn.controller.signal.aborted,false)
  f.progress(text+'不过我刚才说错了。')
  assert.equal(turn.controller.signal.aborted,true)
})

test('a late ASR comma establishes the stable clause boundary without discarding its prepared reaction',async t=>{
  let resolve
  const f=fixture(t,()=>new Promise(done=>{resolve=done}))
  const clause='今天下雨把我的伞吹翻了'
  f.progress(clause,clause)
  const pending=f.p.run();await new Promise(done=>setImmediate(done))
  f.progress(clause+'，大家都看着我笑。')
  resolve(answer);await pending
  assert.ok(f.d.candidate,'late punctuation does not change the already stable fact')
  f.pause(true);assert.ok(f.d.consume(f.d.candidate.id))
  const live=new LiveListening()
  assert.equal(live.relevant(clause,clause+'，不过我刚才说错了。'),false)
  assert.equal(live.relevant('价格是1','价格是1.5元，继续说。'),false)
  assert.equal(live.relevant('今天我本来想','今天我本来想买伞，后来没买。'),false)
})

test('early prompt offers only wait and a short host response',()=>{
  const request=participationRequest({listeningOpportunity:true},{model:'test'})
  assert.deepEqual(request.tools[0].function.parameters.properties.action.enum,['wait','reply_host'])
  assert.match(request.messages[0].content,/不超过4字/)
})

test('a recent full answer does not suppress listening, while delivered reactions have their own spacing',async t=>{
  const f=fixture(t)
  f.d.lastParticipation=10000
  f.progress();await f.p.run()
  assert.ok(f.d.candidate,'listening must not inherit the 15-second topic cooldown')
  f.pause(true)
  const turn=f.d.consume(f.d.candidate.id)
  turn.answer=turn.preparedReply;turn.delivery='audio';turn.generationDone=true
  f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'started',playedChars:0})
  f.s.playbackEvent({turn:turn.id,audioId:turn.audioId,event:'ended',playedChars:turn.answer.length})
  f.advance(1000);f.progress(text+'它还把毛线球叼过来了。');await f.p.run()
  assert.equal(f.d.candidate,null)
  f.advance(3000);await f.p.run()
  assert.ok(f.d.candidate,'new content can earn a reaction after its own quiet budget')
  assert.equal(f.d.lastParticipation,10000,'short reactions do not consume the full-answer budget')
})

test('final punctuation corrections do not repeat an already delivered early response',async t=>{
  let calls=0
  const f=fixture(t,async()=>{calls++;return answer})
  f.progress(text.slice(0,-1));await f.p.run();f.pause(true)
  const turn=f.d.consume(f.d.candidate.id)
  turn.answer=turn.preparedReply;f.s.finish(turn)
  f.final(text);await f.p.run()
  assert.equal(calls,1)
  assert.equal(f.d.consumedUtterance,1)
})

test('ending recognition without a final discards speculative speech and releases the speaking flag',async t=>{
  const f=fixture(t);f.progress();await f.p.run();f.pause(true)
  const turn=f.d.consume(f.d.candidate.id)
  f.event({type:'speech-end'})
  assert.equal(turn.controller.signal.aborted,true)
  assert.equal(f.s.hostSpeaking,false)
  assert.equal(f.d.listening.offer(),null)
  assert.equal(f.d.candidate,null)
})
