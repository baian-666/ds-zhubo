import test from 'node:test'
import assert from 'node:assert/strict'
import { OpeningPreparation } from '../apps/cohost/opening-preparation.mjs'
import { TaskScope } from '../apps/cohost/task-scope.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Scene } from '../apps/cohost/scene.mjs'
const source='我家猫坐着扫地机器人在客厅巡逻'
const answer={action:'reply_host',hostIntent:'spontaneous',text:'这猫老板还挺会享受。',reason:'接住猫巡逻的画面。'}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
function bank(t,plan=async()=>answer) {
  let time=10000
  const tasks=new TaskScope({name:'test-opening'}),closed=[]
  const o=new OpeningPreparation({tasks,plan,now:()=>time,prepareSpeech:()=>({playable:true,close(){closed.push(true)}})})
  t.after(()=>{o.clear();tasks.close()})
  return {o,closed,advance:ms=>time+=ms,snapshot:{latestHost:{id:1,text:source}}}
}
test('an opening survives continued speech but can only be claimed by its exact offered id and sentence',async t=>{
  const {o,snapshot,closed}=bank(t)
  o.start(snapshot);await flush()
  const [offer]=o.offer(source+'，它还一脸严肃')
  assert.equal(offer.text,answer.text)
  assert.equal(o.take(999,source,answer.text),undefined)
  assert.equal(o.take(offer.id,source,'不相干的回答。'),undefined)
  const item=o.take(offer.id,source+'，你觉得呢？',answer.text)
  assert.equal(item.speech.playable,true);assert.equal(o.items.length,0)
  assert.equal(closed.length,0,'transferred audio remains owned by the ordinary turn')
  item.speech.close()
})
test('correction, expiry, cancellation and late completions cannot revive an opening',async t=>{
  const {o,snapshot,advance,closed}=bank(t)
  o.start(snapshot);await flush()
  assert.equal(o.offer('我说的是狗，不是猫。'),undefined);assert.equal(closed.length,1)
  advance(4100);o.clear();o.start(snapshot);await flush();advance(15001)
  assert.equal(o.offer(source),undefined);assert.equal(closed.length,2)
  let release,discard=0
  o.plan=()=>new Promise(resolve=>release=resolve)
  o.clear();o.start(snapshot);await flush();o.clear()
  release({...answer,replyStream:{close(){discard++}}});await flush();await flush()
  assert.equal(o.items.length,0);assert.equal(discard,1)
})
test('opening work is rate bounded and does not leave an unconsumed model stream',async t=>{
  let calls=0,closed=0
  const {o,snapshot,advance}=bank(t,async()=>{calls++;return {...answer,replyStream:{close(){closed++}}}})
  o.start(snapshot);await flush()
  o.start({...snapshot,latestHost:{id:1,text:source+'它还一脸严肃，像是在检查员工有没有偷懒'}})
  assert.equal(calls,1);assert.equal(closed,1)
  advance(4000);o.start({...snapshot,latestHost:{id:1,text:source+'它还一脸严肃，像是在检查员工有没有偷懒'}});await flush()
  assert.equal(calls,2);assert.equal(closed,2)
})

test('the final review can choose either ready opening and only transfers the selected audio',async t=>{
  const {o,snapshot,advance,closed}=bank(t)
  o.start(snapshot);await flush()
  advance(4100)
  const text=source+'它坐着不动等我过去推连一步路都不肯走'
  o.plan=async()=>({...answer,text:'它连司机都有了。'})
  o.start({...snapshot,latestHost:{id:1,text}});await flush()
  const offers=o.offer(text+'你觉得该不该发工资')
  assert.equal(offers.length,2)
  assert.equal(offers[0].text,answer.text)
  assert.equal(offers[1].text,'它连司机都有了。')
  const chosen=o.take(offers[0].id,text,offers[0].text)
  assert.equal(chosen.speech.playable,true)
  assert.equal(closed.length,1,'unselected audio closes, selected audio stays owned by the answer')
  assert.equal(o.items.length,0)
  chosen.speech.close()
})
test('opening audio waits behind short reactions and remains silent until the normal director adopts it',async t=>{
  const {o,snapshot}=bank(t)
  let shortReaction=true
  o.canPrepareSpeech=()=>!shortReaction
  o.start(snapshot);await flush()
  assert.equal(o.items.length,1);assert.equal(o.items[0].speech,undefined)
  assert.equal(o.offer(source),undefined)
  shortReaction=false
  assert.equal(o.offer(source)[0].text,answer.text)
  assert.equal(o.items[0].speech.playable,true)
})
test('speech-time opening preparation coexists with listening and still needs final input and a director adoption',async t=>{
  let time=10000
  const now=()=>time,s=new Scheduler({now}),d=new Director({scheduler:s,now}),scene=new Scene(),calls=[]
  const p=new Participation({director:d,scheduler:s,scene,now,enabled:true,openingPreparationEnabled:true,debounceMs:10000,
    prepareSpeech:()=>({playable:true,close(){}}),plan:async snapshot=>{calls.push(snapshot);return snapshot.openingPreparation?answer:{...answer,hostIntent:'invited',openingId:snapshot.preparedOpenings[0].id}}})
  t.after(()=>{p.close();d.close()})
  d.event({type:'mode',value:'auto'});d.event({type:'speech-start',utterance:1})
  d.event({type:'speech-progress',utterance:1,text:source+'，它还一脸严肃',confirmed:''});time+=250;p.notify();await flush()
  assert.equal(calls.length,1);assert.equal(calls[0].openingPreparation,true)
  assert.equal(s.hostSpeaking,true);assert.equal(d.candidate,null);assert.equal(s.active,null)
  d.event({type:'speech-pause',utterance:1,paused:false});p.notify()
  assert.equal(p.openingPreparation.items.length,1)
  d.event({type:'transcript',utterance:1,text:source+'，你觉得呢？',final:true});p.notify()
  assert.equal(d.candidate,null)
  d.event({type:'speech-end',utterance:1});await p.run()
  assert.equal(d.candidate.preparedReply,answer.text);assert.equal(d.candidate.preparedSpeech.playable,true)
  assert.equal(calls.length,2,'the ordinary answer request also validates the opening')
  assert.equal(d.candidate.listening,undefined,'ordinary floor rules remain in force')
})

test('unpunctuated streaming text prepares silently and completed VAD clauses survive into the next input',async t=>{
  let time=10000
  const now=()=>time,s=new Scheduler({now}),d=new Director({scheduler:s,now}),scene=new Scene(),calls=[]
  const p=new Participation({director:d,scheduler:s,scene,now,enabled:true,openingPreparationEnabled:true,debounceMs:10000,
    prepareSpeech:()=>({playable:true,close(){}}),plan:async snapshot=>{calls.push(snapshot);return answer}})
  t.after(()=>{p.close();d.close()})
  d.event({type:'mode',value:'auto'});d.event({type:'speech-start',utterance:1})
  const first='我家猫坐着扫地机器人在客厅巡逻'
  d.event({type:'speech-progress',utterance:1,text:first,confirmed:''});time+=250;p.notify();await flush()
  assert.equal(calls[0].latestHost.text,first)
  assert.equal(s.active,null);assert.equal(d.candidate,null)
  d.event({type:'transcript',utterance:1,text:first,final:true});p.notify()
  const id=p.openingPreparation.items[0].id
  d.event({type:'speech-start',utterance:2});p.notify()
  d.event({type:'speech-progress',utterance:2,text:'小鲸鱼你觉得这个老板',confirmed:''});p.notify()
  assert.equal(p.openingPreparation.items[0].id,id)
  assert.equal(p.openingInput('小鲸鱼你觉得这个老板'),first+'，小鲸鱼你觉得这个老板')
  d.event({type:'transcript',utterance:2,text:'小鲸鱼你觉得这个老板该不该发工资',final:true});p.notify()
  d.event({type:'speech-end',utterance:2})
  assert.equal(p.context().preparedOpenings[0].id,id)
  p.invalidate()
  assert.equal(p.openingInputState,null)
  assert.equal(p.openingPreparation.items.length,0)
})

test('a VAD endpoint does not discard an unfinished opening for still-valid preceding content',async t=>{
  let time=10000,release
  const now=()=>time,s=new Scheduler({now}),d=new Director({scheduler:s,now}),scene=new Scene()
  const p=new Participation({director:d,scheduler:s,scene,now,enabled:true,openingPreparationEnabled:true,debounceMs:10000,
    prepareSpeech:()=>({playable:true,close(){}}),plan:()=>new Promise(resolve=>{release=resolve})})
  t.after(()=>{p.close();d.close()})
  d.event({type:'mode',value:'auto'});d.event({type:'speech-start',utterance:1})
  d.event({type:'speech-progress',utterance:1,text:source,confirmed:''});time+=250;p.notify();await flush()
  const pending=p.openingPreparation.pending
  p.recognitionFinishing(1)
  d.event({type:'transcript',utterance:1,text:source,final:true});p.syncOpeningPreparation()
  d.event({type:'speech-start',utterance:2});p.syncOpeningPreparation()
  assert.equal(p.openingPreparation.pending,pending)
  release(answer);await flush()
  assert.equal(p.openingPreparation.items.length,1)
  assert.equal(s.active,null);assert.equal(d.candidate,null)
  p.invalidate()
  assert.equal(p.openingPreparation.items.length,0)
})
