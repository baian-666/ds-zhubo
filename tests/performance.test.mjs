import {testCapabilities} from './fixtures/performance.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {Performance,performedText} from '../apps/cohost/performance.mjs'
import {createApp} from '../apps/cohost/server.mjs'
import {Scheduler} from '../apps/cohost/scheduler.mjs'
import {Director} from '../apps/cohost/director.mjs'
import {Scene} from '../apps/cohost/scene.mjs'
import {Participation} from '../apps/cohost/participation.mjs'
import {parseParticipation} from '../apps/cohost/participation-model.mjs'

test('recent accepted motion plans are bounded, scope-specific and replace a turn draft',()=>{
 let now=1000;const p=new Performance({now:()=>now}),target={modelId:'whale',revision:'0123456789abcdef'}
 p.play('nod',{scope:'a',target,turn:1})
 const motion={label:'轻侧头',frames:[{ms:400,holdMs:0,pose:{headZ:0.12}},{ms:500,holdMs:0,pose:{headZ:0}}]}
 p.play('idle',{scope:'a',target,turn:1,motion})
 assert.equal(p.recentPlans('a',target).length,1)
 assert.deepEqual(p.recentPlans('a',target)[0].poses,['headZ'])
 p.recentPlans('a',target)[0].poses.push('mouthOpen')
 assert.deepEqual(p.recentPlans('a',target)[0].poses,['headZ'])
 assert.deepEqual(p.recentPlans('b',target),[])
 assert.deepEqual(p.recentPlans('a',{...target,revision:'fedcba9876543210'}),[])
 assert.equal(p.play('unknown',{scope:'a',target}),false)
 assert.equal(p.recentPlans('a',target).length,1)
 for(let turn=2;turn<10;turn++)p.play('idle',{scope:'a',target,turn})
 assert.equal(p.recentPlans('a',target).length,6)
 now+=90001;assert.deepEqual(p.recentPlans('a',target),[])
})

test('streamed pose prefix survives every split and cannot leak into spoken text',async()=>{
 const source='<perform:smile>才不是大肥鱼！'
 for(let i=0;i<=source.length;i++){
  const actions=[],text=[]
  for await(const chunk of performedText([source.slice(0,i),source.slice(i)],x=>actions.push(x)))text.push(chunk)
  assert.equal(text.join(''),'才不是大肥鱼！');assert.deepEqual(actions,['smile'])
 }
 const actions=[],text=[]
 for await(const x of performedText(['<perform:arbitrary-tool>你好'],x=>actions.push(x)))text.push(x)
 assert.deepEqual(actions,[]);assert.equal(text.join(''),'你好')
 for await(const x of performedText(['<perform:smi'],()=>assert.fail()))assert.fail(x)
})

test('expired, muted and aborted poses release while stale cancellation preserves newer turns',()=>{
 let time=10;const p=new Performance({now:()=>time})
 p.play('smile',{turn:1,durationMs:100});p.play('pout',{turn:2,durationMs:100})
 p.cancel(1);assert.equal(p.snapshot().name,'pout')
 assert.equal(p.snapshot({muted:true}).name,'idle')
 p.cancel(2);assert.equal(p.snapshot({hostSpeaking:true}).name,'listen')
 p.play('nod',{durationMs:100});time+=101;assert.equal(p.snapshot().name,'idle')
 assert.equal(p.play('evil'),false)
})

test('reaction is single, bounded and does not claim a speech turn',async t=>{
 const scheduler=new Scheduler(),director=new Director({scheduler}),scene=new Scene(),reactions=[]
 const result={action:'react',hostIntent:'none',performance:'pout',text:'？',reason:'我用表情接一下，不抢话。',targetId:'',platform:''}
 const p=new Participation({director,scheduler,scene,enabled:true,plan:async()=>result,onReaction:x=>reactions.push(x)})
 t.after(()=>p.close());director.event({type:'mode',value:'auto'})
 director.event({type:'speech-start',utterance:1});director.event({type:'transcript',utterance:1,text:'蓝色大肥鱼，先别说话我还没讲完。',final:true});director.event({type:'speech-end',utterance:1})
 await p.run();await p.run()
 assert.equal(reactions.length,1);assert.equal(scheduler.active,null);assert.equal(director.candidate,null)
 const message=args=>({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(args)}}]})
 assert.equal(parseParticipation(message(result)).text,'？')
 assert.throws(()=>parseParticipation(message({...result,text:'x'.repeat(41)})))
 assert.equal(parseParticipation(message({...result,performance:'unsafe'})).performance,undefined)
})

test('old decision requests preserve the newer candidate and Xiaojingyu has a fast handover',()=>{
 const scheduler=new Scheduler(),d=new Director({scheduler});d.event({type:'mode',value:'auto'})
 for(const id of [1,2]){d.event({type:'speech-start',utterance:id});d.event({type:'transcript',utterance:id,text:'小鲸鱼，你觉得呢？',final:true});d.event({type:'speech-end',utterance:id})}
 const current=d.candidate.id;assert.equal(d.consume(current-1),null);assert.equal(d.candidate.id,current)
 assert.ok(d.consume(current))
})

test('server exposes pose intent, strips markers from history and clears after interrupt',async t=>{
 const prompts=[]
 const app=createApp({apiKey:'test-only',token:'',reply:async function*({history}){prompts.push(history);yield '<perform:';yield 'pout>才不是！'}})
 app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.close();app.closeAllConnections()})
 const url='http://127.0.0.1:'+app.address().port
 const post=(path,body)=>fetch(url+'/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 await post('runtime-profile',{stage:'desktop',owner:'desktop-owner',card:null,capabilities:testCapabilities(['生气'])})
 const answer=await post('reply',{source:'host',text:'大肥鱼'}).then(r=>r.text())
 assert.ok(!answer.includes('<perform:'))
 let state=await fetch(url+'/api/status').then(r=>r.json());assert.equal(state.performance.name,'pout');assert.equal(state.persona,'小鲸鱼')
 await post('interrupt',{});state=await fetch(url+'/api/status').then(r=>r.json());assert.equal(state.performance.name,'idle')
 await post('reply',{source:'host',text:'再说一次'}).then(r=>r.text());assert.equal(prompts[1][1].content,'才不是！')
 assert.equal((await post('performance',{name:'script'})).status,400)
})

test('waiting and generating do not invent confusion, while explicit expressions remain available',()=>{
 let now=0;const p=new Performance({now:()=>now})
 for(const state of [{busy:true},{thinking:true},{busy:true,thinking:true},{hostSpeaking:true},{hostSpeaking:true,thinking:true}]){
  assert.equal(p.snapshot(state).name,state.hostSpeaking||state.thinking?'listen':'idle')
  assert.equal(p.snapshot(state).source,'state')
 }
 p.play('smile',{durationMs:1000})
 assert.equal(p.snapshot({thinking:true}).name,'smile')
 now=1001;assert.equal(p.snapshot({thinking:true}).name,'listen')
 p.play('think',{source:'model'})
 assert.equal(p.snapshot({busy:true}).name,'think')
 p.clear();p.play('think',{source:'preview'})
 assert.equal(p.snapshot().name,'think')
 assert.equal(p.snapshot({muted:true,thinking:true}).name,'idle')
})
