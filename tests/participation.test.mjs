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
test('new speech and expired prepared candidates cannot be published',async t=>{
 let finish;const f=fixture(t,()=>new Promise(r=>{finish=r}));f.host('你说呢？');const work=f.p.run();f.host('换个问题，你说呢？');finish(action());await work
 assert.equal(f.director.candidate,null)
 f.p.plan=async()=>action();await f.p.run();assert.ok(f.director.candidate)
 const id=f.director.candidate.id;f.director.candidate.expiresAt=Date.now()-1;assert.equal(f.director.consume(id),null)
})

test('invalid optional actions preserve speech; misplaced components use full safety validation',()=>{
 const parse=args=>parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(args)}}]})
 const bad=parse(action('reply_host',{performance:'unsafe',motion:{label:'错误',frames:[{ms:300,pose:{mouthOpen:1}}]}}))
 assert.equal(bad.text,action().text);assert.equal(bad.motion,undefined);assert.equal(bad.performance,undefined)
 assert.deepEqual(bad.warnings,['performance_dropped','motion_dropped'])
 const motion={label:'摇尾',frames:[{ms:400,holdMs:900,pose:{headZ:.12}},{ms:400,pose:{headZ:-.08}}]}
 const repaired=parse(action('reply_host',{motion,components:{peace:1,tailBase:.35,tailMid:-.3,tailTip:.4}}))
 assert.equal(repaired.motion.frames[0].components.peace,1);assert.equal(repaired.motion.frames[0].components.tailMid,-.3)
 assert.deepEqual(repaired.warnings,['components_relocated']);assert.equal(repaired.motion.frames[1].components,undefined)
 for(const components of [{peace:2},{arbitrary:1}])assert.equal(parse(action('reply_host',{motion,components})).motion,undefined)
 for(const motion of [null,[],{label:'坏结构',frames:{0:{pose:{}}}}]) {
  const result=parse(action('reply_host',{motion,components:{peace:1}}));assert.equal(result.text,action().text);assert.equal(result.motion,undefined)
 }
 assert.throws(()=>parse({...action(),executeCommand:'unsafe'}),error=>error.code==='arguments')
 for(const args of [null,[],{...action(),text:''}])assert.throws(()=>parse(args))
})

test('safe diagnostics distinguish provider failures and never expose upstream bodies',async t=>{
 const {ParticipationError}=await import('../apps/cohost/participation-model.mjs')
 const options={signal:new AbortController().signal,apiKey:'test-only'}
 for(const [status,code] of [[401,'credentials'],[403,'credentials'],[429,'rate_limit'],[503,'provider']]) {
  await assert.rejects(()=>planParticipation({}, {...options,fetchImpl:async()=>new Response('SECRET-UPSTREAM',{status})}),error=>error.code===code&&!error.message.includes('SECRET'))
 }
 await assert.rejects(()=>planParticipation({}, {...options,fetchImpl:async()=>{throw Error('SECRET-NETWORK')}}),error=>error.code==='network'&&!error.message.includes('SECRET'))
 await assert.rejects(()=>planParticipation({}, {...options,fetchImpl:async()=>Response.json({choices:[{finish_reason:'length'}]})}),error=>error.code==='truncated')
 const f=fixture(t,async()=>{throw new ParticipationError('credentials')});f.host('你说呢？');await f.p.run()
 assert.equal(f.director.trace.at(-1).errorCode,'credentials');assert.ok(f.director.trace.at(-1).explanation.includes('密钥'))
 assert.equal(f.director.candidate,null)
})

test('background danmaku cannot cancel a host reply or trigger another planning call',async t=>{
 let finish,calls=0;const f=fixture(t,()=>{calls++;return new Promise(r=>{finish=r})})
 f.director.event({type:'viewer-window',value:true})
 f.host('你说呢？');const work=f.p.run()
 for(let n=0;n<30;n++){
  f.scheduler.enqueue({id:String(n),platform:'manual',userId:String(n),text:'路过'+n,mentioned:true})
  f.scene.add('viewer','路过'+n);f.p.notify()
 }
 assert.equal(f.p.job.controller.signal.aborted,false)
 finish(action());await work;assert.ok(f.director.candidate);assert.equal(calls,1)
 const turn=f.director.consume(f.director.candidate.id);assert.equal(turn.preparedReply,action().text)
})

test('semantic invitation replaces an active answer, while spontaneous speech cannot',async t=>{
 for(const invited of [true,false]) {
  const f=fixture(t,async()=>action('reply_host',{hostIntent:invited?'invited':'spontaneous'}))
  const old=f.scheduler.beginHost('上一句回答');f.host('请帮我总结一下。');await f.p.run()
  assert.equal(old.controller.signal.aborted,invited)
  if(invited)assert.equal(f.director.consume(f.director.candidate.id).preparedReply,action().text)
  else assert.equal(f.director.candidate,null)
 }
})

test('an acknowledgment does not block a new eligible audience question',async t=>{
 const f=fixture(t,async()=>action('reply_viewer',{targetId:'q',platform:'manual'}));f.host('嗯，对')
 f.director.event({type:'viewer-window',value:true});f.scheduler.enqueue({id:'q',platform:'manual',userId:'viewer',text:'相关问题',mentioned:true})
 await f.p.run();assert.equal(f.director.candidate.messageId,'q')
})

test('both participation paths share delivered history and topic changes retain bounded memories',async t=>{
 let snapshots=[],direct=[]
 const server=createApp({apiKey:'test-only',semanticEnabled:true,participationOptions:{debounceMs:1},
  planner:async snapshot=>{snapshots.push(snapshot);return action('wait')},
  reply:async function*(context){direct.push(context);yield '猫叫年糕。'}})
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})
 const base='http://127.0.0.1:'+server.address().port
 const post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
 await (await post('reply',{source:'host',text:'猫叫年糕，记住了吗？',engine:'deepseek'})).text()
 await post('director/event',{type:'topic-change'})
 await post('director/event',{type:'mode',value:'auto'})
 for(const e of [{type:'speech-start'},{type:'transcript',text:'刚才猫叫什么来着？',final:true},{type:'speech-end'}])await post('director/event',{...e,utterance:1})
 for(let n=0;n<100&&!snapshots.length;n++)await delay(10)
 assert.equal(snapshots[0].currentTopic,2);assert.equal(snapshots[0].history.at(-1).content,'猫叫年糕。')
 assert.ok(snapshots[0].scene.some(x=>x.topic===1&&x.text.includes('年糕')))
 await (await post('reply',{source:'host',text:'再回想一下',engine:'deepseek'})).text()
 assert.deepEqual(direct[1].history,snapshots[0].history);assert.equal(direct[1].currentTopic,2)
 await post('reset',{})
 await (await post('reply',{source:'host',text:'新的一场',engine:'deepseek'})).text()
 assert.equal(direct[2].history.length,0);assert.equal(direct[2].currentTopic,1)
 const s=new Scene({limit:2});s.host('旧场');s.nextTopic();s.host('新话题');s.add('viewer','新弹幕');assert.equal(s.entries.length,2)
})
