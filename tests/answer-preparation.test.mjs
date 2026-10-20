import test from 'node:test'
import assert from 'node:assert/strict'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Scene } from '../apps/cohost/scene.mjs'
import { PreparedSpeech } from '../apps/cohost/prepared-speech.mjs'

const text='你觉得猫老板应该给我发工资吗？'
const answer={action:'reply_host',hostIntent:'invited',text:'当然，猫条结算。',reason:'接住这个问题。'}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
function setup(t,plan=async()=>answer,experimental=true) {
  let time=10000
  const now=()=>time,s=new Scheduler({now}),d=new Director({scheduler:s,now}),scene=new Scene()
  const p=new Participation({director:d,scheduler:s,scene,plan,enabled:true,now,debounceMs:10000,...(experimental?{answerPreparationEnabled:true}:{})})
  t.after(()=>{p.close();d.close()})
  const event=body=>{
    const revision=d.revision
    d.event({utterance:1,...body})
    if(d.revision!==revision)p.invalidate({preserveAnswer:body.type==='transcript' && body.final && d.intent!=='stop' && p.answerPreparation.matches(1,body.text)})
  }
  event({type:'mode',value:'auto'});event({type:'speech-start'})
  const prepare=()=>{event({type:'speech-progress',text,confirmed:''});event({type:'speech-pause',paused:true});time+=500;event({type:'speech-pause',paused:true});p.notify()}
  const final=(value=text)=>{event({type:'transcript',text:value,final:true});event({type:'speech-end'});p.notify()}
  return {s,d,p,event,prepare,final,advance:ms=>time+=ms}
}

test('production defaults keep full speculation disabled while ordinary final replies remain available',async t=>{
  const calls=[],f=setup(t,async snapshot=>{calls.push(snapshot);return answer},false)
  f.prepare();await flush()
  assert.equal(f.p.answerPreparation.current,null);assert.equal(calls.length,0)
  f.final();await f.p.run()
  assert.equal(calls.length,1);assert.equal(calls[0].answerPreparation,undefined)
  assert.equal(f.d.candidate.preparedReply,answer.text)
})

test('full answer preparation stays silent and transfers only after identical final ASR and speech end',async t=>{
  const calls=[],f=setup(t,async snapshot=>{calls.push(snapshot);return answer})
  f.prepare();await flush()
  assert.equal(calls.length,1);assert.equal(calls[0].answerPreparation,true)
  assert.equal(f.d.candidate,null);assert.equal(f.s.active,null)
  f.event({type:'transcript',text,final:true});f.p.notify()
  assert.equal(f.d.candidate,null,'the final transcript alone cannot authorize playback')
  f.event({type:'speech-end'});f.p.notify()
  assert.equal(f.d.candidate.preparedReply,answer.text)
  assert.equal(f.d.candidate.listening,undefined,'normal floor rules apply to the full answer')
  assert.equal(f.d.candidate.timings.answerPrepared,true)
  assert.ok(f.d.consume(f.d.candidate.id));assert.equal(calls.length,1)
})

test('local recognition completion prepares in production, but only identical final ASR can play',async t=>{
  const calls=[],f=setup(t,async snapshot=>{calls.push(snapshot);return answer},false)
  const prepared=[]
  f.p.answerPreparation.prepareSpeech=options=>{prepared.push(options);return undefined}
  f.prepare();await flush();assert.equal(calls.length,0)
  f.p.recognitionFinishing(999);await flush();assert.equal(calls.length,0)
  f.p.recognitionFinishing(1);await flush()
  assert.equal(calls.length,1);assert.equal(calls[0].endOfSpeechPreparation,true)
  assert.equal(prepared.length,1);assert.equal(prepared[0].firstSentenceOnly,true)
  assert.equal(f.d.candidate,null);assert.equal(f.s.active,null)
  f.final();assert.equal(f.d.candidate.preparedReply,answer.text)
  assert.equal(f.d.candidate.timings.answerPrepared,true)
})

test('local completion cannot prepare over ordinary speech or survive a new speech segment',async t=>{
  let calls=0,closed=0
  const f=setup(t,async()=>{calls++;return {...answer,replyStream:{close(){closed++}}}},false)
  f.prepare();f.s.observeHostSpeaking(false);f.s.beginHost('正在回答')
  f.p.recognitionFinishing(1);await flush();assert.equal(calls,0)
  f.s.interrupt('test');f.p.recognitionFinishing(1);await flush();assert.equal(calls,1)
  f.event({type:'speech-start',utterance:2});f.p.notify()
  assert.equal(f.p.answerPreparation.current,null);assert.equal(closed,1)
})

test('local completion prepares beside a pending short reaction without cancelling or replacing it',async t=>{
  let reaction,signal
  const calls=[],f=setup(t,(snapshot,options)=>{
    calls.push(snapshot)
    if(snapshot.listeningOpportunity){signal=options.signal;return new Promise(resolve=>reaction=resolve)}
    return Promise.resolve(answer)
  },false)
  f.prepare();const work=f.p.run();await flush()
  assert.equal(calls.length,1);assert.equal(calls[0].listeningOpportunity,true)
  f.p.recognitionFinishing(1);await flush()
  assert.equal(calls.length,2);assert.equal(calls[1].endOfSpeechPreparation,true)
  assert.equal(signal.aborted,false);assert.equal(f.d.candidate,null);assert.equal(f.s.active,null)
  reaction({...answer,text:'哈！'});await work
  assert.equal(f.d.candidate.listening,true);assert.equal(f.d.candidate.preparedReply,'哈！')
  assert.equal(f.p.answerPreparation.current.result.text,answer.text)
  assert.equal(signal.aborted,false)
})

test('waveform resumption cancels local completion preparation before a new VAD segment arrives',async t=>{
  let closed=0
  const f=setup(t,async()=>({...answer,replyStream:{close(){closed++}}}),false)
  f.prepare();f.p.recognitionFinishing(1);await flush()
  f.event({type:'speech-pause',paused:false});f.p.notify()
  assert.equal(f.p.finishingUtterance,null);assert.equal(f.p.answerPreparation.current,null)
  assert.equal(closed,1);assert.equal(f.s.active,null)
})

test('final review never waits for an unfinished local-end draft that could return wait', {timeout:1000},async t=>{
  let release,closed=0
  const calls=[],f=setup(t,snapshot=>{
    calls.push(snapshot)
    return snapshot.endOfSpeechPreparation?new Promise(resolve=>release=resolve):Promise.resolve(answer)
  },false)
  f.prepare();f.p.recognitionFinishing(1);await flush();f.final()
  await f.p.run()
  assert.equal(calls.length,2);assert.equal(calls[1].answerPreparation,undefined)
  assert.equal(f.d.candidate.preparedReply,answer.text)
  release({...answer,text:'旧草稿。',replyStream:{close(){closed++}}});await flush()
  assert.equal(closed,1);assert.equal(f.d.candidate.preparedReply,answer.text)
})

test('an identical in-flight draft can beat the on-time final review without speaking twice',async t=>{
  let draft,ordinary,discarded=0
  const f=setup(t,snapshot=>new Promise(resolve=>{if(snapshot.endOfSpeechPreparation)draft=resolve;else ordinary=resolve}),false)
  f.prepare();f.p.recognitionFinishing(1);await flush();f.final()
  const work=f.p.run();await flush()
  assert.equal(typeof ordinary,'function','normal work starts without waiting for the draft')
  draft(answer);await work
  assert.equal(f.d.candidate.preparedReply,answer.text);assert.equal(f.d.candidate.timings.answerPrepared,true)
  ordinary({...answer,text:'晚到的新答案。',replyStream:{close(){discarded++}}});await flush()
  assert.equal(discarded,1);assert.equal(f.d.candidate.preparedReply,answer.text)
})

test('a speculative wait cannot suppress or delay the normal answer',async t=>{
  let draft,ordinary
  const f=setup(t,snapshot=>new Promise(resolve=>{if(snapshot.endOfSpeechPreparation)draft=resolve;else ordinary=resolve}),false)
  f.prepare();f.p.recognitionFinishing(1);await flush();f.final()
  const work=f.p.run();await flush()
  draft({action:'wait',hostIntent:'none',text:'',reason:'仍在听。'});await flush()
  assert.equal(f.d.candidate,null)
  ordinary(answer);await work
  assert.equal(f.d.candidate.preparedReply,answer.text);assert.equal(f.d.candidate.timings.answerPrepared,undefined)
})

test('simultaneous speculative and normal completions transfer one stream and close the loser',async t=>{
  for(const order of ['draft-first','normal-first']) {
    let draft,ordinary
    const closed=[]
    const f=setup(t,snapshot=>new Promise(resolve=>{if(snapshot.endOfSpeechPreparation)draft=resolve;else ordinary=resolve}),false)
    f.prepare();f.p.recognitionFinishing(1);await flush();f.final()
    const work=f.p.run();await flush()
    const a={...answer,text:'预备首句。',replyStream:{close(){closed.push('draft')}}}
    const b={...answer,text:'正式首句。',replyStream:{close(){closed.push('normal')}}}
    if(order==='draft-first'){draft(a);ordinary(b)}else {ordinary(b);draft(a)}
    await work;await flush()
    assert.equal(closed.length,1,order)
    assert.equal(closed[0],f.d.candidate.preparedReply===a.text?'normal':'draft')
  }
})

test('resuming, corrected words, stop, mute and topic changes discard unspoken answers',async t=>{
  for(const change of ['resume','correction','stop','mute','topic']) {
    let closed=0
    const f=setup(t,async()=>({...answer,replyStream:{close(){closed++}}}))
    f.prepare();await flush()
    if(change==='resume')f.event({type:'speech-pause',paused:false})
    if(change==='correction')f.event({type:'speech-progress',text:'不是发工资，我问的是请假。',confirmed:''})
    if(change==='stop')f.event({type:'transcript',text:'停停停，先听我讲完。',final:true})
    if(change==='mute')f.s.setMuted(true)
    if(change==='topic')f.event({type:'topic-change'})
    f.p.notify()
    assert.equal(f.p.answerPreparation.current,null,change);assert.equal(closed,1,change)
    assert.equal(f.s.active,null,change)
  }
})

test('final ASR can join an unfinished preparation without a second model request',async t=>{
  let resolve,calls=0
  const f=setup(t,()=>{calls++;return new Promise(done=>resolve=done)})
  f.prepare();f.final();const work=f.p.run();await flush()
  resolve(answer);await work
  assert.equal(calls,1);assert.equal(f.d.candidate.preparedReply,answer.text)
})

test('active ordinary speech never enters full-answer preparation during acknowledgments',async t=>{
  let calls=0
  const f=setup(t,async()=>{calls++;return answer})
  f.s.observeHostSpeaking(false);const turn=f.s.beginHost('正在讲故事')
  f.prepare();await flush()
  assert.equal(f.p.answerPreparation.current,null);assert.equal(calls,0)
  assert.equal(turn.controller.signal.aborted,false)
})

test('changed final discards a draft and uses the ordinary final decision',async t=>{
  let calls=0,closed=0
  const f=setup(t,async snapshot=>{calls++;return {...answer,text:snapshot.answerPreparation?'旧答案。':'新答案。',replyStream:{close(){closed++}}}})
  f.prepare();await flush();f.final('其实我问的是猫老板会不会给我放假？');await f.p.run()
  assert.equal(calls,2);assert.equal(closed,1);assert.equal(f.d.candidate.preparedReply,'新答案。')
})

test('streaming prepared audio replays available PCM immediately and aborts while awaiting later PCM',async()=>{
  let emit,release,calls=0
  const speech={revision:1,async stream(_text,options){calls++;emit=options.emit;await new Promise(resolve=>release=resolve)}}
  const prepared=new PreparedSpeech(speech,answer.text,'neutral',Date.now,{streaming:true})
  emit({type:'audio',sampleRate:24000,pcm:'AAAAAA=='})
  const controller=new AbortController(),heard=[]
  const replay=prepared.replay(answer.text,{signal:controller.signal,emit:event=>heard.push(event)})
  assert.equal(heard.length,1);assert.equal(calls,1)
  controller.abort();await assert.rejects(replay)
  prepared.close();release();await prepared.done
  assert.equal(heard.length,1);assert.equal(prepared.frames.length,0)
})

test('prepared stream preserves all PCM and completion in order without duplicate synthesis',async()=>{
  let emit,release
  const speech={revision:1,async stream(_text,options){emit=options.emit;await new Promise(resolve=>release=resolve)}}
  const prepared=new PreparedSpeech(speech,answer.text,'neutral',Date.now,{streaming:true})
  const first={type:'audio',sampleRate:24000,pcm:'AAAAAA=='},second={...first,pcm:'AQABAA=='}
  emit(first)
  const heard=[],replay=prepared.replay(answer.text,{emit:event=>heard.push(event)})
  emit(second);emit({type:'done'});release();await replay
  assert.deepEqual(heard,[first,second,{type:'done'}])
  assert.throws(()=>prepared.replay(answer.text,{emit(){}}))
  prepared.close()
})

test('preparation cannot revive a late model result after the speaker resumes',async t=>{
  let resolve,closed=0
  const f=setup(t,()=>new Promise(done=>resolve=done))
  f.prepare();f.event({type:'speech-pause',paused:false});f.p.notify()
  resolve({...answer,replyStream:{close(){closed++}}});await flush()
  assert.equal(closed,1);assert.equal(f.d.candidate,null);assert.equal(f.p.answerPreparation.current,null)
})

test('expired pause lease discards the draft and identical pauses do not retry paid preparation',async t=>{
  let calls=0
  const f=setup(t,async()=>{calls++;return answer})
  f.prepare();await flush();f.advance(701);f.p.syncAnswerPreparation()
  assert.equal(f.p.answerPreparation.current,null)
  f.event({type:'speech-pause',paused:true});f.p.syncAnswerPreparation();await flush()
  assert.equal(calls,1)
})

test('explicit addressed handover also reuses a ready draft through the ordinary director',async t=>{
  let calls=0
  const f=setup(t,async()=>{calls++;return answer}),question='小鲸鱼，你觉得猫老板会发工资吗？'
  f.event({type:'speech-progress',text:question,confirmed:question})
  f.event({type:'speech-pause',paused:true});f.advance(500);f.event({type:'speech-pause',paused:true});f.p.notify();await flush()
  f.final(question)
  assert.equal(calls,1);assert.equal(f.d.candidate.preparedReply,answer.text)
  assert.ok(f.d.consume(f.d.candidate.id))
})

test('explicit handover joins an existing pending answer instead of starting duplicate generation',async t=>{
  let resolve
  const f=setup(t,()=>new Promise(done=>resolve=done)),question='小鲸鱼，你觉得猫老板会发工资吗？'
  f.event({type:'speech-progress',text:question,confirmed:question})
  f.event({type:'speech-pause',paused:true});f.advance(500);f.event({type:'speech-pause',paused:true});f.p.notify()
  f.final(question);assert.equal(f.p.awaitingAnswer(),true)
  resolve(answer);await flush();f.p.notify()
  assert.equal(f.p.awaitingAnswer(),false);assert.equal(f.d.candidate.preparedReply,answer.text)
})

test('a settled pause prioritizes the full answer over an unplayed short-reaction model request',async t=>{
  let closed=0,release
  const calls=[],f=setup(t,snapshot=>{
    calls.push(snapshot)
    if(snapshot.listeningOpportunity)return new Promise(resolve=>release=resolve)
    return Promise.resolve(answer)
  })
  f.event({type:'speech-progress',text,confirmed:text});const short=f.p.run();await flush()
  f.event({type:'speech-pause',paused:true});f.advance(500);f.event({type:'speech-pause',paused:true});f.p.notify()
  await short;await flush()
  release({...answer,text:'对。',replyStream:{close(){closed++}}});await flush()
  assert.equal(calls.length,2);assert.equal(calls[1].answerPreparation,true)
  assert.equal(closed,1);assert.equal(f.s.active,null)
  f.final();assert.equal(f.d.candidate.preparedReply,answer.text)
})

test('draft matching preserves internal punctuation, numbers and negation',async t=>{
  const f=setup(t)
  const a=f.p.answerPreparation
  a.current={utterance:1,text:'价格是2.5元，别停。',controller:new AbortController()}
  assert.equal(a.matches(1,'价格是2.5元，别停！'),true)
  assert.equal(a.matches(1,'价格是25元，别停。'),false)
  assert.equal(a.matches(1,'价格是2.5元，别，停。'),false)
  assert.equal(a.matches(1,'价格是2.5元，停。'),false)
})

test('changing ASR tails have a finite preparation budget and a new segment gets a fresh budget',async t=>{
  let calls=0
  const f=setup(t,async()=>{calls++;return answer}),a=f.p.answerPreparation
  for(let index=0;index<9;index++) {
    a.clear();a.start({latestHost:{id:1,text:'识别中的不同尾巴'+index}});await flush()
  }
  assert.equal(calls,6)
  a.clear();a.start({latestHost:{id:2,text:'下一段新的问题'}});await flush()
  assert.equal(calls,7)
})

test('adopted full speech no longer inherits the shorter speculative timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  let signal,emit,release
  const speech={revision:1,async stream(_text,options){signal=options.signal;emit=options.emit;await new Promise(resolve=>release=resolve)}}
  const prepared=new PreparedSpeech(speech,answer.text,'neutral',Date.now,{streaming:true})
  emit({type:'audio',sampleRate:24000,pcm:'AAAAAA=='})
  const replay=prepared.replay(answer.text,{emit(){}})
  t.mock.timers.tick(8001);assert.equal(signal.aborted,false)
  emit({type:'done'});release();await replay;prepared.close()
})
