import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {PendingThought} from '../apps/cohost/pending-thought.mjs'
import {Participation} from '../apps/cohost/participation.mjs'
import {parseParticipation} from '../apps/cohost/participation-model.mjs'
import {Scene} from '../apps/cohost/scene.mjs'
import {Scheduler} from '../apps/cohost/scheduler.mjs'
import {Director} from '../apps/cohost/director.mjs'
import {createApp} from '../apps/cohost/server.mjs'

const action=(kind='wait',fields={})=>({action:kind,hostIntent:'none',reason:'先让主播讲完，等下一句再接回。',
 text:'',targetId:'',platform:'',...fields})
const thought={text:'等主播讲完，再接回猫抢占跑步机的梗。',wake:'next_host_turn'}
function fixture(t,plan,options={}) {
 let now=1000,id=0
 const clock=()=>now,scene=new Scene({now:clock}),scheduler=new Scheduler({now:clock}),director=new Director({scheduler,now:clock})
 const p=new Participation({director,scheduler,scene,now:clock,enabled:true,plan,...options})
 t.after(()=>{p.close();director.close()});director.event({type:'mode',value:'auto'})
 director.onTranscript=({text,utterance})=>scene.host(text,utterance)
 const host=text=>{director.event({type:'speech-start',utterance:++id});director.event({type:'transcript',utterance:id,text,final:true});director.event({type:'speech-end',utterance:id})}
 return {p,scene,scheduler,director,host,advance:ms=>now+=ms}
}

test('notes are optional bounded intentions; bad notes cannot cancel a valid core decision',()=>{
 const parse=args=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(args)}}]})
 assert.deepEqual(parse(action('wait',{thought})).thought,thought)
 for(const invalid of [{text:'x'.repeat(121),wake:'next_host_turn'},{text:'',wake:'next_host_turn'},{...thought,execute:'unsafe'},{...thought,wake:'every_second'}]) {
  const result=parse(action('wait',{thought:invalid}));assert.equal(result.action,'wait');assert.equal(result.thought,undefined);assert.ok(result.warnings.includes('thought_dropped'))
 }
 assert.throws(()=>parse(action('reply_followup',{hostIntent:'spontaneous',text:'补一句',thoughtId:0})))
 assert.throws(()=>parse(action('reply_followup',{hostIntent:'invited',text:'补一句',thoughtId:1})))
})

test('next-turn notes never poll during quiet and appear in the next live snapshot only once',async t=>{
 const snapshots=[]
 const f=fixture(t,async snapshot=>{snapshots.push(snapshot);return snapshots.length===1?action('wait',{thought}):action('reply_host',{hostIntent:'invited',text:'年糕才是跑步机的主人。'})})
 f.host('我的猫叫年糕，它霸占跑步机。先听我讲完。');await f.p.run()
 f.advance(3000);for(let n=0;n<30;n++)await f.p.run()
 assert.equal(snapshots.length,1);assert.equal(f.p.status().pendingThought.text,thought.text)
 f.host('我讲完了，你来接一句。');await f.p.run()
 assert.equal(snapshots[1].pendingThought.text,thought.text);assert.equal(snapshots[1].pendingOpportunity,false)
 assert.equal(f.p.status().pendingThought,null);assert.ok(f.director.consume(f.director.candidate.id))
})

test('after-reply review waits for an actual successful playback, a quiet gap and proactive cooldown',async t=>{
 let calls=0
 const f=fixture(t,async snapshot=>{
  calls++;return calls===1?action('wait',{thought:{...thought,wake:'after_reply'}}):action('reply_followup',{hostIntent:'spontaneous',thoughtId:snapshot.pendingThought.id,text:'所以年糕是跑步机的房东。'})
 })
 const old=f.scheduler.beginHost('正在解释');old.delivery='audio';old.answer='完整的原回复'
 f.host('年糕今天又在跑步机上睡了一下午。');await f.p.run()
 f.scheduler.finish(old);f.advance(3000);await f.p.run();assert.equal(calls,1,'generation is not playback completion')
 assert.equal(f.scheduler.playbackEvent({turn:old.id,audioId:old.audioId,event:'started'}),true)
 assert.equal(f.scheduler.playbackEvent({turn:old.id,audioId:old.audioId,event:'ended',playedChars:old.answer.length}),true)
 await f.p.run();assert.equal(calls,1,'need a quiet gap after actual completion')
 f.director.lastParticipation=4000;f.advance(1300);await f.p.run();assert.equal(calls,1,'cooldown is enforced')
 f.advance(15000);await f.p.run();assert.equal(calls,2)
 const id=f.director.candidate.id,turn=f.director.consume(id)
 assert.equal(turn.input.source,'followup');assert.equal(turn.preparedReply,'所以年糕是跑步机的房东。')
 assert.equal(f.director.consume(id),null);assert.equal(f.p.status().pendingThought,null)
 f.scheduler.finish(turn);await f.p.run();assert.equal(calls,2,'no self-generated continuation loop')
})

test('cancelled playback cannot open a quiet follow-up window',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return action('wait',{thought:{...thought,wake:'after_reply'}})})
 const old=f.scheduler.beginHost('正在解释');old.delivery='audio';old.answer='没播完的回答';f.scheduler.finish(old)
 f.host('这里有一个新笑点。');await f.p.run()
 f.scheduler.playbackEvent({turn:old.id,audioId:old.audioId,event:'error',playedChars:0})
 f.advance(5000);await f.p.run();assert.equal(calls,1);assert.equal(f.p.context().pendingOpportunity,false)
})

test('quiet wait or failure consumes the sole review budget, and new speech rejects a late review',async t=>{
 for(const outcome of ['wait','error','late']) {
  let calls=0,resolve
  const f=fixture(t,async()=>{
   if(++calls===1)return action('wait',{thought:{...thought,wake:'after_reply'}})
   if(outcome==='error')throw Error('fixture-only')
   if(outcome==='late')return new Promise(r=>{resolve=r})
   return action('wait',{thought:{...thought,wake:'after_reply'}})
  })
  const old=f.scheduler.beginHost('解释中');old.answer='已读完';f.host('讲一个新笑点。');await f.p.run();f.scheduler.finish(old);f.advance(1300)
  const work=f.p.run()
  if(outcome==='late'){f.host('我继续讲另一件事。');resolve(action('reply_followup',{hostIntent:'spontaneous',thoughtId:1,text:'迟到补充'}))}
  await work;assert.equal(f.director.candidate,null)
  if(outcome!=='late')for(let n=0;n<10;n++){f.advance(300);await f.p.run()}
  assert.equal(calls,2)
 }
})

test('one intention expires, is replaced rather than queued, and is discarded on control boundaries',async t=>{
 let now=0;const notes=new PendingThought({now:()=>now,ttlMs:10})
 notes.set(thought,{topic:1,utterance:1});notes.set({...thought,text:'替换'},{topic:1,utterance:2})
 assert.equal(notes.snapshot(1).text,'替换');now=10;assert.equal(notes.snapshot(1),null)
 notes.set(thought,{topic:1,utterance:2});assert.equal(notes.snapshot(2),null)
 for(const control of ['mute','manual','disable','stop','topic']) {
  const f=fixture(t,async()=>action('wait',{thought}));f.host('先听我讲完。');await f.p.run()
  if(control==='mute')f.scheduler.setMuted(true)
  if(control==='manual')f.director.event({type:'mode',value:'manual'})
  if(control==='disable')f.p.setEnabled(false)
  if(control==='stop')f.host('停一下')
  if(control==='topic'){f.director.event({type:'topic-change'});f.scene.nextTopic()}
  assert.equal(f.p.status().pendingThought,null,control)
 }
})

test('expired intention cannot be consumed through an otherwise current prepared decision',async t=>{
 let calls=0;const f=fixture(t,async snapshot=>++calls===1?action('wait',{thought:{...thought,wake:'after_reply'}}):action('reply_followup',{text:'补一句',hostIntent:'spontaneous',thoughtId:snapshot.pendingThought.id}),{thoughtOptions:{ttlMs:1350}})
 const old=f.scheduler.beginHost('前一句');old.answer='已送达';f.host('有个新梗。');await f.p.run();f.scheduler.finish(old);f.advance(1300);await f.p.run()
 const id=f.director.candidate.id;f.advance(60);assert.equal(f.director.consume(id),null)
})

test('explicit handover carries the same note into unified generation without a separate reply call',async t=>{
 let plannerCalls=0,contexts=[]
 const server=createApp({apiKey:'test-only',token:'',semanticEnabled:true,rehearsal:true,participationOptions:{debounceMs:1},
  planner:async args=>{plannerCalls++;contexts.push(args);return plannerCalls===1?action('wait',{thought}):action('reply_host',{hostIntent:'invited',text:'年糕是跑步机的房东。'})},reply:async function*(){assert.fail('must reuse prepared reply')}})
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})
 const base='http://127.0.0.1:'+server.address().port
 const post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
 const status=()=>fetch(base+'/api/status').then(r=>r.json())
 const host=async(id,text)=>{for(const event of [{type:'speech-start'},{type:'transcript',text,final:true},{type:'speech-end'}])await post('director/event',{...event,utterance:id})}
 await host(1,'年糕在跑步机睡觉。先听我讲完。')
 for(let n=0;n<100&&!(await status()).participation.pendingThought;n++)await delay(10)
 assert.equal(plannerCalls,1)
 await host(2,'小鲸鱼，你觉得年糕是不是房东？')
 let state
 for(let n=0;n<100;n++){state=await status();if(state.director.candidate)break;await delay(10)}
 assert.ok(state.director.candidate)
 await (await post('reply',{source:'director',decision:state.director.candidate.id,engine:'deepseek'})).text()
 assert.equal(contexts[1].pendingThought.text,thought.text);assert.equal(plannerCalls,2)
 assert.equal((await status()).participation.pendingThought,null)
 for(const [path,body] of [['interrupt',{}],['mute',{value:true}],['reset',{}]]) {
  await post(path,body);state=await status();assert.equal(state.participation.pendingThought,null)
 }
})
