import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, SessionPersistence } from '../apps/cohost/session-store.mjs'
import { parseParticipation, ParticipationError } from '../apps/cohost/participation-model.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Scene } from '../apps/cohost/scene.mjs'

const parse=args=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(args)}}]})
const reply={action:'reply_host',hostIntent:'invited',reason:'回应问题。',text:'我还记得刚才的话。',targetId:'',platform:''}

test('unfinished audio timings and preparation flags cannot block durable chat and delivered memory',t=>{
  const dir=mkdtempSync(join(tmpdir(),'cohost-chat-validation-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const path=join(dir,'session.sqlite'),store=new SessionStore(path)
  const snapshot={format:1,room:{session:'trial',version:1,entries:[{id:1,role:'assistant',text:'在壳子里聊的话也要保存。',at:100,
    timings:{ttsPreparedAt:100,preparedFirstPcmAt:undefined,answerPrepared:true,invalid:NaN,negative:-1}}]},scene:{topic:1,version:0,entries:[]},memories:[{
    id:'delivered',characterId:'whale',engine:'deepseek',input:{source:'host',text:'你有什么感受？'},text:'在壳子里聊的话也要保存。',at:100,topic:1,delivery:'text',complete:true,interrupted:false}]}
  const persistence=new SessionPersistence(store,()=>snapshot)
  try{
    persistence.schedule();assert.equal(persistence.flush(),true)
    snapshot.room.entries.push({id:2,role:'host',text:'后面又聊了一句。',at:101});snapshot.room.version++
    persistence.schedule();assert.equal(persistence.flush(),true)
    assert.equal(persistence.status().error,null)
    assert.equal(snapshot.room.entries[0].timings.answerPrepared,true)
  }finally{persistence.close()}
  const next=new SessionStore(path)
  try{
    assert.equal(next.restored.room.entries.length,2)
    assert.equal(next.restored.memories[0].text,snapshot.memories[0].text)
    assert.deepEqual(next.restored.room.entries[0].timings,{ttsPreparedAt:100})
  }finally{next.close()}
})

test('host replies do not require empty viewer fields or an explanation; extra data is never executed',()=>{
  const result=parse({action:'reply_host',hostIntent:'invited',text:'好，接着聊。',executeCommand:'DO-NOT-EXECUTE',note:'ordinary extra metadata'})
  assert.equal(result.text,'好，接着聊。')
  assert.equal(result.targetId,'');assert.equal(result.platform,'')
  assert.equal(result.executeCommand,undefined);assert.equal(result.note,undefined)
  assert.ok(result.reason)
  assert.equal(parse({...reply,reason:'解释'.repeat(200)}).reason.length,180)
})

test('invalid actions, audience routing and handover fields remain rejected with precise safe diagnostics',()=>{
  for(const [args,field] of [[{...reply,action:'DO-NOT-EXECUTE'},'action'],[{...reply,action:'reply_viewer',targetId:undefined},'targetId'],
    [{...reply,action:'reply_viewer',targetId:'viewer',platform:undefined},'platform'],[{...reply,yieldToHost:'true'},'yieldToHost']]){
    assert.throws(()=>parse(args),error=>error.code==='arguments'&&error.field===field&&!error.message.includes('DO-NOT-EXECUTE'))
  }
})

test('operators see the failing reply part without upstream content or a content-policy accusation',async t=>{
  const scheduler=new Scheduler(),director=new Director({scheduler}),scene=new Scene()
  const participation=new Participation({scheduler,director,scene,enabled:true,debounceMs:1,
    plan:async()=>{throw new ParticipationError('arguments','text','too_long')}})
  t.after(()=>participation.close())
  director.event({type:'mode',value:'auto'})
  director.event({type:'speech-start',utterance:1});director.event({type:'transcript',utterance:1,text:'刚才怎么了？',final:true});director.event({type:'speech-end',utterance:1})
  await participation.run()
  const entry=director.trace.at(-1)
  assert.equal(entry.errorCode,'arguments')
  assert.match(entry.explanation,/回复文字.*过长/)
  assert.doesNotMatch(entry.explanation,/不合规|违规/)
  assert.equal(entry.error,'text:too_long')
  assert.equal(director.candidate,null)
})

test('consuming a prepared reply before its first audio never inserts an absent timestamp',async t=>{
  const scheduler=new Scheduler(),director=new Director({scheduler}),scene=new Scene()
  const participation=new Participation({scheduler,director,scene,enabled:true,debounceMs:1,plan:async()=>reply,
    prepareSpeech:()=>({startedAt:Date.now(),close(){}})})
  t.after(()=>{participation.close();director.close()})
  director.event({type:'mode',value:'auto'})
  director.event({type:'speech-start',utterance:1});director.event({type:'transcript',utterance:1,text:'说说你的感受。',final:true});director.event({type:'speech-end',utterance:1})
  await participation.run()
  const turn=director.consume(director.candidate.id)
  assert.ok(turn)
  assert.equal(Number.isSafeInteger(turn.timings.ttsPreparedAt),true)
  assert.equal(Object.hasOwn(turn.timings,'preparedFirstPcmAt'),false)
  scheduler.finish(turn)
})
