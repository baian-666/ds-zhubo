import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve,sep } from 'node:path'
import { SessionContinuity,parseContinuation } from '../apps/cohost/session-continuity.mjs'
import { SessionStore } from '../apps/cohost/session-store.mjs'
import { createApp } from '../apps/cohost/server.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Scene } from '../apps/cohost/scene.mjs'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'

const characterId='builtin:xiaojingyu'
const later={action:'defer',text:'猫占跑步机的事',quote:'稍后再聊猫占跑步机的事'}
const host={id:1,endedAt:1000,text:later.quote+'，我先打这局。'}
const scope={characterId,host,topic:1,action:'wait'}
function memory(t,options={}) {const c=new SessionContinuity(options);t.after(()=>c.close());return c}
const decision=(action,fields={})=>({action,reason:'先让主播打完这局，之后再聊猫。',hostIntent:'none',text:'',targetId:'',platform:'',...fields})

test('idle extractive summary preserves role, topic and confirmed prefix without a model call',async t=>{
  let idle=false
  const c=memory(t,{idle:()=>idle,delayMs:5})
  c.observe({id:1,at:100,topic:1,role:'host',text:'今天打算去河边钓鱼。'},characterId)
  c.observe({id:2,at:101,topic:1,role:'viewer',text:'我听说那条河有鲨鱼。'},characterId)
  await delay(15)
  assert.deepEqual(c.context(characterId,1).sessionSummary,[])
  idle=true;await delay(20)
  assert.equal(c.summary[1].role,'viewer')
  assert.equal(c.summary[1].text,'我听说那条河有鲨鱼。')
  c.observe({id:3,deliveryId:'audio',at:102,topic:1,role:'assistant',engine:'deepseek',text:'我只听到',deliveryState:'partial'},characterId)
  c.observe({id:3,deliveryId:'audio',at:102,topic:1,role:'assistant',engine:'deepseek',text:'我只听到这部分。',deliveryState:'interrupted'},characterId)
  c.observe({id:4,at:103,topic:1,role:'assistant',engine:'mock',text:'不应进入真模型摘要'},characterId)
  await delay(20)
  assert.equal(c.summary.at(-1).text,'我只听到这部分。')
  assert.equal(c.summary.at(-1).deliveryState,'interrupted')
  assert.equal(c.sources.filter(x=>x.id==='audio').length,1)
  assert.deepEqual(c.context('other-character',1).sessionSummary,[])
})

test('summary input and prompt budget stay bounded and clearing cannot resurrect idle work',async t=>{
  const c=memory(t,{delayMs:5})
  for(let id=1;id<=220;id++)c.observe({id,at:id,topic:Math.ceil(id/10),role:id%2?'host':'assistant',engine:'deepseek',text:'鲸🐋'.repeat(150),deliveryState:'complete'},characterId)
  assert.equal(c.sources.length,96)
  c.rebuild()
  const summary=c.context(characterId,22).sessionSummary
  assert.ok(summary.length<=8)
  assert.ok(summary.some(x=>x.at<160),'retain excerpts beyond the 60-entry live scene')
  assert.ok(summary.every(x=>x.text.length<=160))
  assert.ok(c.sources.every(x=>x.text.length<=240))
  c.clearSummary(characterId);await delay(20)
  assert.deepEqual(c.context(characterId,22).sessionSummary,[])
  assert.equal(c.sources.length,0)
  c.observe({id:300,at:300,topic:23,role:'host',text:'新话题只聊天气。'},characterId)
  c.clear();await delay(20)
  assert.deepEqual(c.summary,[])
})

test('a viewer burst does not erase all host excerpts',t=>{
  const c=memory(t)
  c.observe({id:1,at:1,topic:1,role:'host',text:'周末准备一起去钓鱼。'},characterId)
  for(let id=2;id<130;id++)c.observe({id,at:id,topic:1,role:'viewer',text:`观众消息${id}`},characterId)
  c.rebuild()
  assert.ok(c.summary.some(x=>x.role==='host' && x.text==='周末准备一起去钓鱼。'))
  assert.equal(c.sources.filter(x=>x.role==='viewer').length,24)
})

test('maintenance remains separate from output, and clearing invalidates an already running extraction',async t=>{
  const c=memory(t,{delayMs:1});let finish
  c.extract=()=>new Promise(resolve=>{finish=resolve})
  c.observe({id:1,at:1,topic:1,role:'host',text:'这段摘要应被清除。'},characterId)
  // Force a task into its result/commit gap, then clear before its continuation runs.
  await waitFor(()=>finish)
  c.clear();finish([]);await delay(0)
  assert.deepEqual(c.summary,[]);assert.equal(c.tasks.status().running,0)
  const prepared=c.prepare(later,scope);c.close();assert.equal(c.commit(prepared),false)
})

test('maintenance failure retains the previous summary and a later input can retry',async t=>{
  const c=memory(t,{delayMs:1}),extract=c.extract.bind(c)
  c.extract=()=>{throw Error('background-only failure')}
  c.observe({id:1,at:1,topic:1,role:'host',text:'今晚聊聊钓鱼的事情。'},characterId)
  await waitFor(()=>c.tasks.status().recent.some(x=>x.state==='failed'))
  assert.deepEqual(c.context(characterId,1).sessionSummary,[])
  c.extract=extract;c.observe({id:2,at:2,topic:1,role:'host',text:'刚才钓到了一条大鱼。'},characterId)
  await waitFor(()=>c.summary.length)
  assert.equal(c.tasks.status().running,0)
  assert.equal(c.context(characterId,1).sessionSummary[0].role,'host')
})

test('durable items require an exact host quote and cannot be created by viewers or ordinary waits',t=>{
  const c=memory(t)
  assert.equal(c.prepare(later,{...scope,host:null}),null)
  assert.equal(c.prepare(later,{...scope,action:'reply_viewer'}),null)
  assert.equal(c.prepare({...later,quote:'明天去领奖'},{...scope}),null)
  assert.equal(c.prepare({...later,quote:'我先打这局'},{...scope}),null)
  assert.equal(parseContinuation({...later,tool:'execute'}),null)
  const prepared=c.prepare(later,scope)
  assert.equal(c.commit(prepared),true)
  assert.equal(c.commit(prepared),false)
  assert.equal(c.commit(c.prepare(later,scope)),false)
  assert.equal(c.items.length,1)
  assert.equal(c.items[0].source.text,later.quote)
  assert.deepEqual(c.context('other',1).continuations,[])
})

test('topic changes, expiry, deletion and reset reject stale continuation updates',t=>{
  let now=1000
  const c=memory(t,{now:()=>now,ttlMs:100})
  c.commit(c.prepare(later,scope));const id=c.items[0].id
  const resume={action:'resume',id}
  const offered=[id]
  assert.equal(c.context(characterId,2).continuations[0].oldTopic,true)
  assert.equal(c.prepare(resume,{...scope,offered,topic:2,action:'reply_host',host:{text:'今天聊新游戏'}}),null)
  const prepared=c.prepare(resume,{...scope,offered,topic:2,action:'reply_host',host:{text:'继续刚才猫占跑步机的事'}})
  assert.ok(prepared)
  assert.equal(c.prepare(resume,{...scope,offered:[],action:'reply_host'}),null)
  c.remove(id,characterId)
  assert.equal(c.commit(prepared),false)
  c.commit(c.prepare(later,scope));const second=c.items[0].id
  now=1100
  assert.deepEqual(c.context(characterId,1).continuations,[])
  assert.equal(c.items[0].state,'expired')
  assert.equal(c.prepare({action:'resume',id:second},{...scope,offered:[second],action:'reply_host'}),null)
  const stale=c.prepare({...later,text:'新的事情'},scope)
  c.clear();assert.equal(c.commit(stale),false)
})

test('pending item cap never evicts another unresolved promise',t=>{
  const c=memory(t)
  for(let id=1;id<=5;id++) {
    const quote=`稍后聊第${id}个游戏`
    c.commit(c.prepare({...later,text:quote,quote},{...scope,host:{id,text:quote}}))
  }
  assert.equal(c.items.length,4)
  assert.equal(c.items[0].text,'稍后聊第1个游戏')
})

test('durable items do not schedule idle model calls or bypass mute and host control',async t=>{
  let now=1000,calls=0,id=0
  const c=memory(t,{now:()=>now}),scene=new Scene(),scheduler=new Scheduler({now:()=>now}),director=new Director({scheduler,now:()=>now})
  const p=new Participation({director,scheduler,scene,continuity:c,character:()=>characterId,enabled:true,now:()=>now,
    plan:async snapshot=>{calls++;return calls===1?decision('wait',{continuation:later,thought:{text:'稍后接猫的事',wake:'next_host_turn'}}):decision('reply_host',{hostIntent:'invited',text:'猫才是跑步机的主人。',continuation:{action:'resume',id:snapshot.continuations[0].id}})}})
  t.after(()=>{p.close();director.close()});director.event({type:'mode',value:'auto'})
  const say=text=>{id++;director.event({type:'speech-start',utterance:id});director.event({type:'transcript',utterance:id,text,final:true});director.event({type:'speech-end',utterance:id})}
  say(host.text);await p.run();assert.equal(c.items.length,1)
  assert.equal(p.context().pendingThought,null,'durable deferral cannot create a second ephemeral wakeup')
  now+=60000
  for(let i=0;i<30;i++)await p.run()
  assert.equal(calls,1)
  scheduler.setMuted(true);say('继续猫的事吧');await p.run();assert.equal(calls,1)
  scheduler.setMuted(false);say('接着聊猫的事吧');await p.run()
  assert.equal(calls,2)
  const turn=director.consume(director.candidate.id)
  assert.equal(turn.continuation.action,'resume')
  assert.equal(c.items[0].state,'pending','selection is not delivery')
  assert.equal(c.commit(turn.continuation),true)
  assert.equal(c.items[0].state,'resumed')
})

async function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'cohost-continuity-')),path=join(dir,'session.sqlite'),servers=[]
  t.after(async()=>{
    for(const server of servers)if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})
  })
  const start=async()=>{
    const server=createApp({sessionPath:path,apiKey:'fixture',token:'',...options})
    servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening')
    const base=`http://127.0.0.1:${server.address().port}`
    return {server,base,post:(endpoint,body)=>fetch(base+'/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),status:()=>fetch(base+'/api/status').then(r=>r.json()),stop:()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))}}
  }
  return {path,start}
}
async function waitFor(fn) {for(let n=0;n<150;n++){const result=await fn();if(result)return result;await delay(15)}throw new Error('condition did not settle')}
async function say(api,text,id) {
  for(const body of [{type:'speech-start',utterance:id},{type:'transcript',utterance:id,text,final:true},{type:'speech-end',utterance:id}]) {
    const r=await api.post('director/event',body);assert.equal(r.status,200)
  }
}

test('SQLite upgrade preserves original records, quote provenance and pending expiry across restart',async t=>{
  const f=await fixture(t,{semanticEnabled:true,participationOptions:{debounceMs:1},planner:async()=>decision('wait',{continuation:later})})
  const old=new SessionStore(f.path)
  old.save({format:1,room:{session:'old',version:1,entries:[{id:1,role:'host',at:100,text:'旧气泡还在'}]},scene:{topic:1,version:0,entries:[]},memories:[]});old.close()
  let api=await f.start();await api.post('director/event',{type:'mode',value:'auto'})
  await say(api,host.text,1)
  await waitFor(async()=>((await api.status()).sessionMemory.continuity.items.length===1))
  const before=await api.status(),id=before.sessionMemory.continuity.items[0].id
  await api.stop();api=await f.start()
  const recovered=await api.status()
  assert.ok(recovered.room.entries.some(x=>x.text==='旧气泡还在'))
  assert.equal(recovered.sessionMemory.continuity.items[0].id,id)
  assert.equal(recovered.sessionMemory.continuity.items[0].source.text,later.quote)
  assert.equal(recovered.sessionMemory.continuity.items[0].oldTopic,true)
  assert.equal(recovered.busy,false)
  assert.equal((await api.post('session-memory',{session:before.room.session,characterId,action:'remove-item',id})).status,409)
  assert.equal((await api.post('session-memory',{session:recovered.room.session,characterId,action:'remove-item',id})).status,200)
  await api.stop();api=await f.start()
  assert.deepEqual((await api.status()).sessionMemory.continuity.items,[])
})

test('normal first sentence streams before late continuity metadata; interrupted audio remains pending',async t=>{
  let release,first=true
  const f=await fixture(t,{semanticEnabled:true,participationOptions:{debounceMs:1},planner:async snapshot=>{
    if(first){first=false;return decision('wait',{continuation:later})}
    const id=snapshot.continuations[0].id
    return decision('reply_host',{hostIntent:'invited',text:'猫就是跑步机的主人。',replyStream:{close(){release?.()},async *[Symbol.asyncIterator](){yield {kind:'speech',text:'猫就是跑步机的主人。'};await new Promise(resolve=>{release=resolve});yield {kind:'presentation',continuation:{action:'resume',id}}}}})
  }})
  const api=await f.start();await api.post('director/event',{type:'mode',value:'auto'})
  await say(api,host.text,1);await waitFor(async()=>((await api.status()).sessionMemory.continuity.items.length===1))
  await say(api,'继续猫的事，聊两句。',2)
  const candidate=await waitFor(async()=>(await api.status()).director.candidate)
  const response=await api.post('reply',{source:'director',decision:candidate.id,engine:'deepseek',delivery:'audio'})
  const reader=response.body.getReader(),decoder=new TextDecoder();let body=''
  while(!body.includes('猫就是跑步机的主人。'))body+=decoder.decode((await reader.read()).value)
  assert.equal((await api.status()).sessionMemory.continuity.items[0].state,'pending')
  release()
  while(true){const part=await reader.read();if(part.done)break;body+=decoder.decode(part.value)}
  const start=JSON.parse(body.trim().split('\n')[0])
  await api.post('playback',{turn:start.turn,audioId:start.audioId,event:'started'})
  await api.post('playback',{turn:start.turn,audioId:start.audioId,event:'progress',playedChars:1})
  await api.post('interrupt',{})
  assert.equal((await api.status()).sessionMemory.continuity.items[0].state,'pending')
  await api.stop()
  const restarted=await f.start()
  assert.equal((await restarted.status()).sessionMemory.continuity.items[0].state,'pending')
})

test('late stream metadata cannot cancel speech when malformed',async()=>{
  const records=[{kind:'decision',...decision('reply_host',{hostIntent:'invited',text:'先回答当前问题。'})},{kind:'presentation',continuation:{action:'execute',command:'bad'}},{kind:'speech',text:'这句话也正常送达。'}]
  const data=JSON.stringify({records})
  const event={choices:[{index:0,delta:{tool_calls:[{index:0,function:{name:'participate',arguments:data}}]},finish_reason:null}]}
  const body=`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`
  const result=await streamParticipation({}, {fetchImpl:async()=>new Response(body)})
  const received=[];for await(const record of result.replyStream)received.push(record)
  assert.equal(received[1].continuation,undefined)
  assert.equal(received.at(-1).text,'这句话也正常送达。')
})

test('only full confirmed delivery marks a continuation resumed, with no replay after recovery',async t=>{
  let calls=0
  const f=await fixture(t,{semanticEnabled:true,participationOptions:{debounceMs:1},planner:async snapshot=>{
    calls++
    return calls===1?decision('wait',{continuation:later}):decision('reply_host',{hostIntent:'invited',text:'猫把跑步机当床，我站旁边当教练。',continuation:{action:'resume',id:snapshot.continuations[0].id}})
  }})
  let api=await f.start();await api.post('director/event',{type:'mode',value:'auto'})
  await say(api,host.text,1);await waitFor(async()=>((await api.status()).sessionMemory.continuity.items.length===1))
  await say(api,'继续聊刚才跑步机上的猫吧。',2)
  const candidate=await waitFor(async()=>(await api.status()).director.candidate)
  const response=await api.post('reply',{source:'director',decision:candidate.id,engine:'deepseek',delivery:'audio'})
  const lines=(await response.text()).trim().split('\n').map(x=>JSON.parse(x)),start=lines[0]
  const text=lines.filter(x=>x.type==='delta').map(x=>x.text).join('')
  assert.equal((await api.status()).sessionMemory.continuity.items[0].state,'pending')
  await api.post('playback',{turn:start.turn,audioId:start.audioId,event:'started'})
  await api.post('playback',{turn:start.turn,audioId:start.audioId,event:'ended',playedChars:text.length})
  assert.equal((await api.status()).sessionMemory.continuity.items[0].state,'resumed')
  await api.stop();api=await f.start()
  assert.equal((await api.status()).sessionMemory.continuity.items[0].state,'resumed')
  assert.equal((await api.status()).busy,false)
  await delay(350);assert.equal(calls,2,'recovery cannot initiate another model call')
  const state=await api.status()
  await api.post('reset',{session:state.room.session})
  await api.stop();api=await f.start()
  assert.deepEqual((await api.status()).sessionMemory.continuity.items,[])
  assert.deepEqual((await api.status()).sessionMemory.continuity.summary,[])
})
