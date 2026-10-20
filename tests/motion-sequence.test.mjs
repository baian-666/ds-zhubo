import {testCapabilities} from './fixtures/performance.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {parseMotionSequence,sampleMotionSequence,sequenceDuration} from '../integrations/airi/motion-sequence.ts'
import {Performance,performedText} from '../apps/cohost/performance.mjs'
import {createApp} from '../apps/cohost/server.mjs'
import {parseParticipation} from '../apps/cohost/participation-model.mjs'
import {Scheduler} from '../apps/cohost/scheduler.mjs'
import {Director} from '../apps/cohost/director.mjs'
import {Participation} from '../apps/cohost/participation.mjs'
import {Scene} from '../apps/cohost/scene.mjs'

const motion={label:'侧目后轻笑',frames:[
 {ms:800,pose:{eyeX:-0.6,headZ:-0.2},expression:{name:'think',strength:0.5}},
 {ms:1000,pose:{eyeX:0.4,headZ:0.3,mouthForm:0.5},expression:{name:'smile',strength:0.8}},
]}
test('sequence boundary rejects arbitrary controls, impossible values and long plans',()=>{
 assert.deepEqual(parseMotionSequence(motion),motion)
 const invalid=[
  {...motion,code:'run'}, {...motion,frames:[]}, {...motion,frames:Array(5).fill(motion.frames[0])},
  {...motion,frames:Array(4).fill({...motion.frames[0],ms:1800})},
  {...motion,frames:[{ms:500,pose:{mouthOpen:1}}]}, {...motion,frames:[{ms:500,pose:{offsetX:1}}]},
  {...motion,frames:[{ms:500,pose:{headZ:0.9}}]}, {...motion,frames:[{ms:NaN,pose:{}}]},
  {...motion,frames:[{ms:500,pose:{eyeX:Infinity}}]}, {...motion,frames:[{ms:500,pose:[],expression:{name:'script',strength:1}}]},
  {...motion,frames:[{ms:500,pose:{},expression:{name:'smile',strength:2}}]},
 ]
 for(const value of invalid)assert.equal(parseMotionSequence(value),null)
 const detached=parseMotionSequence(motion);detached.frames[0].pose.eyeX=1
 assert.equal(motion.frames[0].pose.eyeX,-0.6)
})
test('sampling preserves phase, smooths targets and fades between expression owners',()=>{
 assert.equal(sequenceDuration(motion),3400)
 assert.equal(sampleMotionSequence(motion,400).pose.eyeX,-0.3)
 const middle=sampleMotionSequence(motion,2100)
 assert.equal(middle.step,2);assert.equal(middle.expressions.at(-1).strength,0)
 assert.ok(Math.abs(middle.pose.eyeX+0.1)<1e-9)
 assert.equal(sampleMotionSequence(motion,3400).finished,true)
})
test('control markers across every stream split never enter speech; text before a plan is immediate',async()=>{
 const marker='<act:'+JSON.stringify(motion)+'>'
 const source='才没有摸鱼。'+marker+'这是战略思考。'
 for(let i=0;i<=source.length;i++){
  const actions=[]
  const chunks=await Array.fromAsync(performedText([source.slice(0,i),source.slice(i)],(...args)=>actions.push(args)))
  assert.equal(chunks.join(''),'才没有摸鱼。这是战略思考。')
  assert.deepEqual(actions,[['sequence',motion]])
 }
 let release
 async function* delayed(){yield '先说第一句。';await new Promise(r=>release=r);yield marker}
 const output=performedText(delayed(),()=>{})
 assert.equal((await output.next()).value,'先说第一句。')
 const pending=output.next();await new Promise(r=>setTimeout(r,0));release();await pending
 const invalid=['<act:{"code":"bad"}>正常文本','<act:'+ 'x'.repeat(4096)+'>正常文本']
 for(const value of invalid)assert.equal((await Array.fromAsync(performedText([value],()=>assert.fail()))).join(''),'正常文本')
 assert.equal((await Array.fromAsync(performedText(['文字<act:{"frames":'],()=>assert.fail()))).join(''),'文字')
})
test('audio plans wait for matching playback, renew without restarting, expire and cancel by turn',()=>{
 let now=100;const p=new Performance({now:()=>now})
 p.play('idle',{motion,turn:3,defer:true})
 now+=10000;assert.equal(p.snapshot().startedAt,null);assert.ok(p.snapshot().expiresAt<=now+5000)
 assert.equal(p.start(2),false);assert.equal(p.start(3),true)
 const started=p.snapshot().startedAt;now+=200
 assert.equal(p.start(3),false);assert.equal(p.snapshot().startedAt,started)
 p.cancel(2);assert.equal(p.snapshot().name,'sequence')
 p.cancel(3);assert.equal(p.snapshot().name,'idle')
 p.play('idle',{motion,turn:4,defer:true});now+=30001
 assert.equal(p.start(4),false);assert.equal(p.snapshot().name,'idle')
})
test('one planner result carries free motion through a reply or nonverbal reaction',async t=>{
 const scheduler=new Scheduler(),director=new Director({scheduler}),scene=new Scene(),reactions=[]
 const result={action:'reply_host',hostIntent:'invited',performance:'idle',motion,text:'我可没摸鱼。',reason:'我接一句。',targetId:'',platform:''}
 const parsed=parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(result)}}]})
 const p=new Participation({director,scheduler,scene,enabled:true,plan:async()=>parsed,onReaction:x=>reactions.push(x)})
 t.after(()=>p.close());director.event({type:'mode',value:'auto'})
 director.event({type:'speech-start',utterance:1});director.event({type:'transcript',utterance:1,text:'你说你有没有摸鱼呀',final:true});director.event({type:'speech-end',utterance:1})
 await p.run();const turn=director.consume(director.candidate.id)
 assert.deepEqual(turn.motion,motion);assert.equal(turn.preparedReply,result.text)
 scheduler.finish(turn)
 director.event({type:'speech-start',utterance:2});director.event({type:'transcript',utterance:2,text:'先让我把故事讲完',final:true});director.event({type:'speech-end',utterance:2})
 director.lastParticipation=-Infinity
 p.plan=async()=>({...parsed,action:'react',hostIntent:'none',text:''})
 await p.run();assert.deepEqual(reactions[0].motion,motion);assert.equal(scheduler.active,null)
})
test('server keeps free controls out of history, rejects invalid preview and cancels animation',async t=>{
 const seen=[];const app=createApp({apiKey:'test',token:'',reply:async function*({history}){seen.push(history);yield '才没有。';yield '<act:'+JSON.stringify(motion)+'>';yield '我在思考。'}})
 app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.close();app.closeAllConnections()})
 const base='http://127.0.0.1:'+app.address().port
 const post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
 await post('runtime-profile',{stage:'desktop',owner:'desktop-owner',card:null,capabilities:testCapabilities()})
 const reply=await(await post('reply',{source:'host',text:'又摸鱼？'})).text()
 assert.ok(!reply.includes('<act:'));assert.ok(!reply.includes('"frames"'))
 let status=await fetch(base+'/api/status').then(r=>r.json())
 assert.deepEqual(status.performance.motion,motion);assert.equal(status.room.entries.at(-1).motionLabel,motion.label)
 await post('interrupt',{})
 status=await fetch(base+'/api/status').then(r=>r.json());assert.equal(status.performance.name,'idle')
 await(await post('reply',{source:'host',text:'继续'})).text()
 assert.equal(seen[1][1].content,'才没有。我在思考。')
 assert.equal((await post('performance',{name:'sequence',motion:{...motion,frames:[{ms:400,pose:{mouthOpen:1}}]}})).status,400)
})

test('model closing-tag variants stay out of speech across every split',async()=>{
 // A real DeepSeek trial returned <act:{json}</act> and the first parser discarded its valid plan.
 const json=JSON.stringify(motion)
 for(const marker of ['<act>'+json+'</act>','<act:'+json+'</act>','<act:'+json+'></act>']){
  const source='前句。'+marker+'后句。'
  for(let i=0;i<=source.length;i++){
   const actions=[]
   assert.equal((await Array.fromAsync(performedText([source.slice(0,i),source.slice(i)],(...args)=>actions.push(args)))).join(''),'前句。后句。')
   assert.deepEqual(actions,[['sequence',motion]])
  }
 }
})

test('target expression stays visible for its hold, including the last frame',()=>{
 const short={label:'看清笑容',frames:[{ms:300,pose:{headZ:0.2},expression:{name:'smile',strength:0.7}}]}
 assert.equal(sequenceDuration(short),1100)
 for(const at of [300,600,1099]){
  const sample=sampleMotionSequence(short,at)
  assert.equal(sample.finished,false);assert.equal(sample.expressions.at(-1).strength,0.7);assert.equal(sample.pose.headZ,0.2)
 }
 assert.equal(sampleMotionSequence(short,1100).finished,true)
 const explicit={...short,frames:[{...short.frames[0],holdMs:1400}]}
 assert.equal(sequenceDuration(parseMotionSequence(explicit)),1700)
 assert.equal(sampleMotionSequence(explicit,1699).expressions.at(-1).strength,0.7)
 assert.equal(sequenceDuration({...short,frames:[{...short.frames[0],holdMs:0}]}),300)
 for(const holdMs of [-1,1801,NaN,1.5,'800'])assert.equal(parseMotionSequence({...short,frames:[{...short.frames[0],holdMs}]}),null)
 assert.equal(parseMotionSequence({...short,frames:Array(4).fill({...short.frames[0],ms:1000,holdMs:1800})}),null)
 let now=0;const p=new Performance({now:()=>now})
 const long={label:'慢些反应',frames:Array(4).fill({...short.frames[0],ms:1000,holdMs:1000})}
 assert.equal(p.play('sequence',{motion:long,turn:1}),true)
 const id=p.snapshot().id
 for(now=0;now<8000;now+=1000){assert.equal(p.snapshot().id,id);assert.ok(p.snapshot().expiresAt<=now+1200)}
 now=8251;assert.equal(p.snapshot().name,'idle')
})