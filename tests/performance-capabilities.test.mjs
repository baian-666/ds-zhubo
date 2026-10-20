import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {readFileSync} from 'node:fs'
import * as v from 'valibot'
import {capabilitiesSchema,emptyCapabilities,performanceTarget,evaluatePerformance,constrainPerformance,motionSequenceSchema} from '../packages/cohost-contracts/performance.ts'
import {parseMotionSequence} from '../packages/cohost-contracts/motion.ts'
import {whaleCapabilities} from '../integrations/airi/whale-capabilities.ts'
import {RuntimeProfile} from '../apps/cohost/runtime-profile.mjs'
import {Performance} from '../apps/cohost/performance.mjs'
import {createApp} from '../apps/cohost/server.mjs'
import {rigPrompt} from '../apps/cohost/performance-prompt.mjs'
import {participationRequest} from '../apps/cohost/participation-model.mjs'

const fake=(modelId='future-avatar')=>({...emptyCapabilities(modelId),adapter:'non-rendering-test',presets:['idle','nod'],poses:['headZ'],expressions:['joy'],
  components:[{name:'earLift',min:0,max:1,discrete:false,description:'竖起耳朵'}]})
const plan={label:'竖耳侧目',frames:[{ms:600,pose:{headZ:0.1},expression:{name:'joy',strength:0.6},components:{earLift:0.4}}]}
const metadata=caps=>({stage:'desktop',owner:'test-stage-owner',card:null,capabilities:caps})

test('a non-Cubism capability substitute supports the same generic wire intent, prompt and gate',()=>{
  const caps=fake(),profile=new RuntimeProfile();profile.update(metadata(caps))
  assert.ok(v.safeParse(capabilitiesSchema,caps).success)
  assert.deepEqual(parseMotionSequence(plan),plan)
  const result=profile.filter({performance:'idle',motion:plan,text:'我在听。'})
  assert.equal(result.text,'我在听。');assert.deepEqual(result.performanceIssues,[])
  const decision=evaluatePerformance({name:'sequence',motion:plan,target:result.performanceTarget,startedAt:0,expiresAt:1000},caps,1)
  assert.equal(decision.outcome,'applied');assert.equal(decision.motion.frames[0].components.earLift,0.4)
  const prompt=rigPrompt(profile.snapshot()),schema=JSON.stringify(motionSequenceSchema(caps))
  assert.ok(prompt.includes('earLift'));assert.ok(schema.includes('earLift'))
  for(const text of [prompt,schema])assert.ok(!/tailBase|ParamCheek|鲸鱼娘|Cubism/.test(text))
  const tools=participationRequest({}, {model:'fixture',profile:profile.snapshot()}).tools
  assert.deepEqual(tools[0].function.parameters.properties.performance.enum,['idle','nod'])
})

test('manifest boundary rejects unsupported versions, duplicate controls, invalid ranges and malformed exclusive groups',()=>{
  for(const caps of [
    {...fake(),version:2},{...fake(),expressions:['joy','joy']},
    {...fake(),aliases:[{name:'smile',expression:'unknown'}]},
    {...fake(),components:[...fake().components,...fake().components]},
    {...fake(),components:[{...fake().components[0],min:NaN}]},
    {...fake(),components:[{...fake().components[0],min:1,max:0}]},
    {...fake(),exclusive:[['earLift','missing']]},
    {...fake(),components:[{...fake().components[0],name:'__proto__'}]},
  ])assert.equal(v.safeParse(capabilitiesSchema,caps).success,false)
})

test('capabilities constrain unknown controls and conflicts without changing the answer',()=>{
  const caps={...fake(),components:[...fake().components,...['leftHand','rightHand'].map(name=>({name,min:0,max:1,discrete:true,description:name}))],exclusive:[['leftHand','rightHand']]}
  const input={...plan,frames:[{ms:600,pose:{headZ:0.1,eyeX:1},expression:{name:'missing',strength:1},components:{earLift:0.3,tailBase:1,leftHand:1,rightHand:1}}]}
  const result=constrainPerformance({performance:'pout',motion:input},caps)
  assert.equal(result.performance,'idle');assert.deepEqual(result.motion.frames[0].pose,{headZ:0.1})
  assert.equal(result.motion.frames[0].expression,undefined);assert.deepEqual(result.motion.frames[0].components,{earLift:0.3})
  assert.ok(result.issues.includes('component:tailBase'));assert.ok(result.issues.some(x=>x.startsWith('conflict:')))
  assert.equal(evaluatePerformance({name:'sequence',motion:input,target:performanceTarget(caps),expiresAt:1000},caps,1).outcome,'partial')
  assert.equal(parseMotionSequence({...plan,frames:[{ms:600,pose:{mouthOpen:1}}]}),null)
  const absent=emptyCapabilities('other')
  assert.equal(evaluatePerformance({name:'sequence',motion:plan,target:performanceTarget(absent),expiresAt:1000},absent,1).outcome,'unsupported')
})

test('model changes, revoked permissions and expired source leases invalidate actions without cancelling speech',()=>{
  let now=0;const profile=new RuntimeProfile({now:()=>now}),performance=new Performance({now:()=>now})
  profile.update(metadata(fake()))
  const offered=performanceTarget(profile.snapshot().capabilities)
  performance.play('sequence',{motion:plan,target:offered,turn:5,defer:true})
  const changed={...fake(),components:[]};profile.update(metadata(changed))
  const current=performanceTarget(profile.snapshot().capabilities)
  assert.equal(evaluatePerformance({name:'sequence',motion:plan,target:offered,expiresAt:1000},changed,1).outcome,'stale')
  assert.equal(performance.snapshot({target:current}).name,'idle')
  const filtered=profile.filter({performance:'idle',motion:plan,text:'仍然正常说话'},offered)
  assert.equal(filtered.text,'仍然正常说话');assert.equal(filtered.motion,undefined);assert.ok(filtered.performanceIssues.includes('stale-capabilities'))
  assert.equal(performance.start(5),true)
  now=30001;assert.deepEqual(profile.snapshot().capabilities.components,[])
  assert.equal(evaluatePerformance({name:'sequence',motion:plan,target:offered,expiresAt:now+1000},profile.snapshot().capabilities,now).outcome,'stale')
})

test('whale adapter advertises only present, authorized parts and keeps pose control separate from expressions',()=>{
  const groups=new Map(Object.entries({'问号':'ParamCheek74','开心兴奋':'ParamCheek76','双手比耶':'phone7','蛋包饭':'danbaofan'})
    .map(([name,parameterId])=>[name,{name,parameters:[{parameterId,value:1}]}]))
  const expressions=new Map([...groups.values()].flatMap(group=>group.parameters.map(p=>[p.parameterId,{}])))
  expressions.set('Param_Angle_Rotation_1_B_tail3',{})
  const store={modelId:'actual-model',expressionGroups:groups,expressions,llmMode:'all',isExposedToLlm:()=>true}
  const all=whaleCapabilities(store,true,'live2d')
  assert.ok(v.safeParse(capabilitiesSchema,all).success)
  assert.ok(all.components.some(x=>x.name==='tailBase'));assert.ok(!all.components.some(x=>x.name==='tailTip'))
  assert.ok(all.components.some(x=>x.name==='omelet'&&x.discrete))
  assert.ok(all.exclusive.some(group=>group.includes('omelet')&&group.includes('peace')))
  expressions.delete('ParamCheek76')
  assert.ok(!whaleCapabilities(store,true,'live2d').expressions.includes('开心兴奋'))
  const disabled=whaleCapabilities(store,false,'live2d')
  assert.deepEqual(disabled.expressions,[]);assert.deepEqual(disabled.components,[]);assert.ok(disabled.poses.includes('headZ'))
  assert.deepEqual(whaleCapabilities(store,true,'vrm'),emptyCapabilities(store.modelId))
})

test('generic performance modules have no AIRI or whale runtime dependency',()=>{
  const seen=new Set()
  function visit(url){
    if(seen.has(url.href))return;seen.add(url.href)
    const text=readFileSync(url,'utf8')
    for(const match of text.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)){
      assert.ok(!/whale|integrations\/airi|stage-ui/.test(match[1]),match[1])
      if(match[1].startsWith('.'))visit(new URL(match[1],url))
    }
  }
  for(const path of ['../packages/cohost-contracts/performance.ts','../apps/cohost/performance.mjs','../apps/cohost/performance-prompt.mjs','../apps/cohost/runtime-profile.mjs'])visit(new URL(path,import.meta.url))
})

test('a late action for an old model is dropped while both text chunks complete',async t=>{
  let announce,release
  const waiting=new Promise(r=>announce=r),continueReply=new Promise(r=>release=r)
  const app=createApp({apiKey:'fixture',token:'',reply:async function*(){yield '先说第一句。';announce();await continueReply;yield '<act>'+JSON.stringify(plan)+'</act>继续第二句。'}})
  app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{release();app.closeAllConnections();app.close()})
  const base='http://127.0.0.1:'+app.address().port
  const post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  assert.equal((await post('runtime-profile',metadata(fake()))).status,200)
  const response=post('reply',{source:'host',text:'竖一下耳朵'})
  await waiting
  assert.equal((await post('runtime-profile',metadata(fake('new-model')))).status,200)
  release();const text=await (await response).text()
  assert.ok(text.includes('先说第一句。'));assert.ok(text.includes('继续第二句。'));assert.ok(!text.includes('<act>'))
  const status=await fetch(base+'/api/status').then(r=>r.json())
  assert.equal(status.room.entries.at(-1).status,'completed');assert.equal(status.performance.name,'idle');assert.ok(status.performance.issues.includes('stale-capabilities'))
  const unsupported=await post('performance',{name:'sequence',motion:{...plan,frames:[{ms:600,pose:{},components:{tailBase:0.4}}]}})
  assert.equal(unsupported.status,422)
})

test('a reaction with no supported controls does not claim that an action was performed',async t=>{
  const app=createApp({apiKey:'fixture',token:'',semanticEnabled:true,participationOptions:{debounceMs:1},
    planner:async()=>({action:'react',hostIntent:'none',reason:'我用动作回应',text:'',targetId:'',platform:'',performance:'idle',motion:plan})})
  app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.closeAllConnections();app.close()})
  const base='http://127.0.0.1:'+app.address().port
  const event=body=>fetch(base+'/api/director/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  await event({type:'mode',value:'auto'})
  for(const item of [{type:'speech-start'},{type:'transcript',text:'让我先把故事讲完',final:true},{type:'speech-end'}])await event({...item,utterance:1})
  let answer
  for(let n=0;n<50;n++){
    const status=await fetch(base+'/api/status').then(r=>r.json());answer=status.room.entries.findLast(x=>x.role==='assistant')
    if(answer)break
    await new Promise(r=>setTimeout(r,10))
  }
  assert.equal(answer?.text,'（暂不表演）');assert.equal(answer.performance,'idle');assert.equal(answer.motionLabel,undefined)
})
