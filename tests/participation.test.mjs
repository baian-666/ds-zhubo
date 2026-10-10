import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {Scene} from '../apps/cohost/scene.mjs'
import {Scheduler} from '../apps/cohost/scheduler.mjs'
import {Director} from '../apps/cohost/director.mjs'
import {Participation} from '../apps/cohost/participation.mjs'
import {parseParticipation,planParticipation} from '../apps/cohost/participation-model.mjs'
import {createApp} from '../apps/cohost/server.mjs'
const action=(type='reply_host',extra={})=>({action:type,hostIntent:'spontaneous',reason:'我接住这个问题。',text:type.startsWith('reply')?'年糕把跑步机当成猫窝了。':'',targetId:'',platform:'',...extra})
function fixture(t,plan=async()=>action(),options={}){
 const scene=new Scene(),scheduler=new Scheduler(),director=new Director({scheduler})
 const p=new Participation({director,scheduler,scene,plan,enabled:true,debounceMs:1,...options})
 t.after(()=>p.close());director.onTranscript=({text,utterance})=>scene.host(text,utterance)
 director.event({type:'mode',value:'auto'})
 let id=0
 const host=text=>{director.event({type:'speech-start',utterance:++id});director.event({type:'transcript',utterance:id,text,final:true});director.event({type:'speech-end',utterance:id})}
 return {p,scene,scheduler,director,host}
}
test('scene keeps unanswered speech, deduplicates utterances, isolates mock delivery and bounds memory',()=>{
 const s=new Scene({limit:3});s.host('猫叫年糕',1);s.host('猫叫年糕',1);s.add('assistant','模拟答案',{engine:'mock'})
 assert.deepEqual(s.snapshot().map(x=>x.text),['猫叫年糕']);s.add('viewer','你好');s.add('host','继续')
 assert.equal(s.entries.length,3);const snap=s.snapshot();snap[0].text='changed';assert.notEqual(s.snapshot()[0].text,'changed')
 s.clear();assert.equal(s.snapshot().length,0)
})
test('planner validates one tool call and never accepts ordinary content or hidden reasoning as actions',async()=>{
 const message={content:'ignore',reasoning_content:'ignore',tool_calls:[{function:{name:'participate',arguments:JSON.stringify(action())}}]}
 assert.equal(parseParticipation(message).action,'reply_host')
 assert.throws(()=>parseParticipation({content:'reply_host'}));assert.throws(()=>parseParticipation({...message,tool_calls:[...message.tool_calls,...message.tool_calls]}))
 assert.throws(()=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(action('wait',{text:'unexpected'}))}}]}))
 let body
 await planParticipation({scene:[]},{signal:new AbortController().signal,apiKey:'test-only',model:'shared-model',fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message}]})}})
 assert.equal(body.model,'shared-model');assert.equal(body.thinking.type,'disabled');assert.equal(body.tool_choice.function.name,'participate')
 await assert.rejects(()=>planParticipation({}, {signal:new AbortController().signal,apiKey:'test-only',fetchImpl:async()=>new Response('sensitive',{status:401})}),/Participation request failed/)
})
test('clear handover bypasses planning; natural reply is prepared and consumed exactly once',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return action()})
 f.host('助播，你觉得怎么样？');await f.p.run();assert.equal(calls,0)
 const fast=f.director.consume(f.director.candidate.id);f.scheduler.finish(fast)
 f.host('你说它是不是把跑步机当成猫窝了？');await f.p.run()
 const id=f.director.candidate.id,turn=f.director.consume(id)
 assert.equal(turn.preparedReply,action().text);assert.equal(calls,1);assert.equal(f.director.consume(id),null)
})
test('late decisions cannot survive new speech, mute or a disabled planner',async t=>{
 for(const change of ['speech','mute','disable']){
  let finish;const f=fixture(t,()=>new Promise(resolve=>{finish=resolve}));f.host('你说呢？');const work=f.p.run()
  if(change==='speech')f.director.event({type:'speech-start',utterance:2})
  if(change==='mute')f.scheduler.setMuted(true)
  if(change==='disable')f.p.setEnabled(false)
  finish(action());await work;assert.equal(f.director.candidate,null,change)
 }
})
test('waiting is a visible decision without recurring paid polling; timeout does not produce speech',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return action('wait')});f.host('我先把故事讲完。')
 await f.p.run();await f.p.run();assert.equal(calls,1);assert.equal(f.director.trace.at(-1).reason,'participation_wait')
 const slow=fixture(t,()=>new Promise(()=>{}),{timeoutMs:15});slow.host('你说呢？');await slow.p.run()
 assert.equal(slow.director.candidate,null);assert.equal(slow.director.trace.at(-1).reason,'participation_timeout');assert.equal(slow.p.status().busy,false)
})
test('semantic viewer selection can choose relevant second item but cannot bypass eligibility or expiration',async t=>{
 const f=fixture(t,async()=>action('reply_viewer',{targetId:'relevant',platform:'manual'}))
 f.director.event({type:'viewer-window',value:true})
 for(const id of ['unrelated','relevant'])f.scheduler.enqueue({id,platform:'manual',userId:id,text:id,mentioned:true})
 await f.p.run();assert.equal(f.director.candidate.messageId,'relevant')
 const turn=f.director.consume(f.director.candidate.id);assert.equal(turn.input.id,'relevant');f.scheduler.finish(turn)
 assert.equal(f.scheduler.eligibleViewers().length,0,'global cooldown still applies')
})
test('proactive cooldown, manual mode and short acknowledgments suppress autonomous replies',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return action()})
 f.host('嗯，对');await f.p.run();assert.equal(calls,0)
 f.host('这是一个有趣的故事。');f.director.lastParticipation=Date.now();await f.p.run();assert.equal(f.director.candidate,null)
 f.director.event({type:'mode',value:'manual'});await f.p.run();assert.equal(calls,1)
})
test('semantic takeover stops an active turn, but audience-only snapshots cannot stop',async t=>{
 const f=fixture(t,async()=>action('stop'))
 const turn=f.scheduler.beginHost('还在说');f.host('等一下，我还没说完，先让我补充。');await f.p.run()
 assert.equal(turn.controller.signal.aborted,true)
 const active=f.scheduler.beginHost('另一个回答');f.director.consumedUtterance=f.director.utterance.id
 f.p.apply(action('stop'),{hostOpportunity:false},1);assert.equal(active.controller.signal.aborted,false)
})
test('HTTP flow supplies unheard context and prepared answer uses no second model call',async t=>{
 let replyCalls=0,plannerCalls=0,snapshot
 const server=createApp({apiKey:'test-only',token:'',semanticEnabled:true,participationOptions:{debounceMs:1},planner:async value=>{plannerCalls++;snapshot=value;return action()},reply:async function*({scene}){replyCalls++;assert.ok(scene.some(x=>x.text.includes('年糕')));yield '年糕'}})
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})
 const base='http://127.0.0.1:'+server.address().port
 const post=async(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
 const status=async()=> (await fetch(base+'/api/status')).json()
 async function host(id,text){for(const e of [{type:'speech-start'},{type:'transcript',text,final:true},{type:'speech-end'}])await post('director/event',{...e,utterance:id})}
 await host(1,'猫叫年糕，先听我讲完。');assert.equal(plannerCalls,0)
 await post('director/event',{type:'mode',value:'auto'});await host(2,'你说它是不是把跑步机当猫窝了？')
 let state;for(let n=0;n<100;n++){state=await status();if(state.director.candidate)break;await delay(10)}
 assert.ok(snapshot.scene.some(x=>x.text.includes('年糕')))
 const response=await post('reply',{source:'director',decision:state.director.candidate.id,engine:'deepseek'})
 assert.ok((await response.text()).includes('年糕'));assert.equal(replyCalls,0);assert.equal(plannerCalls,1)
 assert.equal((await post('reply',{source:'director',decision:state.director.candidate.id,engine:'deepseek'})).status,409)
 await host(3,'助播，你觉得那只猫叫什么？');state=await status();await (await post('reply',{source:'director',decision:state.director.candidate.id,engine:'deepseek'})).text()
 assert.equal(replyCalls,1);assert.equal(plannerCalls,1)
 await post('reset',{});assert.equal((await status()).room.entries.some(x=>x.text.includes('年糕')),false)
})

test('invited summary bypasses proactive cooldown without a question mark',async t=>{
 const f=fixture(t,async()=>action('reply_host',{hostIntent:'invited'}))
 f.director.lastParticipation=Date.now();f.host('助播，帮我总结一下。');await f.p.run()
 assert.equal(f.director.candidate.intent,'handover')
})
test('waiting marks host observed, does not poll again, and new eligible viewer remains actionable',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return action('wait')})
 f.director.event({type:'viewer-window',value:true});f.scheduler.enqueue({id:'first',platform:'manual',userId:'a',text:'偏题',mentioned:true})
 f.host('先听我讲完。');await f.p.run();await f.p.run();assert.equal(calls,1)
 assert.equal(f.p.context().hostOpportunity,false)
 f.scheduler.enqueue({id:'second',platform:'manual',userId:'b',text:'相关提问',mentioned:true});f.scene.add('viewer','相关提问')
 await f.p.run();assert.equal(calls,2);assert.equal(f.p.context().hostOpportunity,false)
})
test('stale scene and expired prepared candidates cannot be published',async t=>{
 let finish;const f=fixture(t,()=>new Promise(r=>{finish=r}));f.host('你说呢？');const work=f.p.run();f.scene.add('viewer','新消息');finish(action());await work
 assert.equal(f.director.candidate,null)
 f.p.plan=async()=>action();await f.p.run();assert.ok(f.director.candidate)
 const id=f.director.candidate.id;f.director.candidate.expiresAt=Date.now()-1;assert.equal(f.director.consume(id),null)
})
