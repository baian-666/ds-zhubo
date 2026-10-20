import {testCapabilities} from './fixtures/performance.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { ParticipationRecords, streamParticipation, streamingParticipationRequest } from '../apps/cohost/participation-stream.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Scene } from '../apps/cohost/scene.mjs'
import { createApp } from '../apps/cohost/server.mjs'

const decision = {kind:'decision',speechStyle:'happy',action:'reply_host',hostIntent:'invited',reason:'主播在问我。',text:'年糕把跑步机当成猫窝了。',targetId:'',platform:''}

test('compact floor output can only classify the current interruption, never speak or issue controls',async()=>{
  for(const intent of ['backchannel','takeover','uncertain']) {
    const u=upstream(),pending=streamParticipation({floorOpportunity:true},{fetchImpl:u.fetchImpl})
    u.args(JSON.stringify({records:[{kind:'floor',intent}]}));u.finish()
    const result=await pending
    assert.equal(result.floorIntent,intent);assert.equal(result.action,'wait');assert.equal(result.text,'')
    assert.equal(result.replyStream,undefined)
  }
  for(const records of [[{kind:'floor',intent:'backchannel',text:'不该生成'}],[{kind:'floor',intent:'backchannel'},{kind:'floor',intent:'takeover'}],
    [{kind:'floor',intent:'invented'}],[{kind:'decision',action:'stop'}]]) {
    const u=upstream(),pending=streamParticipation({floorOpportunity:true},{fetchImpl:u.fetchImpl}),rejected=assert.rejects(pending,/arguments/)
    u.args(JSON.stringify({records}));u.finish();await rejected
  }
})

test('ordinary director can adopt a prepared opening then answer the latest question in the same stream',async()=>{
  const u=upstream(),snapshot={hostOpportunity:true,preparedOpenings:[{id:7,source:'猫坐着巡逻。',text:'这猫老板架子挺大。'},{id:8,source:'猫拍照。',text:'它还挺上镜。'}]}
  const prompt=streamingParticipationRequest(snapshot,{model:'test'}).messages[0].content
  assert.match(prompt,/优先复用/)
  assert.match(prompt,/必须回应最新问题/)
  assert.doesNotMatch(prompt,/直接回复主播的第一项使用kind="answer"|本轮普通回复主播使用更短的首条格式/)
  const pending=streamParticipation(snapshot,{fetchImpl:u.fetchImpl})
  u.args('{"records":[{"kind":"opening","id":7,"hostIntent":"invited"}')
  const result=await pending,reader=result.replyStream[Symbol.asyncIterator]()
  assert.equal(result.openingId,7);assert.equal((await reader.next()).value.text,snapshot.preparedOpenings[0].text)
  u.args(',{"kind":"speech","text":"工资该发，推车另算加班。"}]}');u.finish()
  assert.equal((await reader.next()).value.text,'工资该发，推车另算加班。');assert.equal((await reader.next()).done,true)
})
test('opening token cannot invent content, bypass active-speech handling or inject controls',async()=>{
  for(const [snapshot,record] of [
    [{hostOpportunity:true},{kind:'opening',id:1,hostIntent:'invited'}],
    [{hostOpportunity:true,preparedOpenings:[{id:2,text:'旧开头。'}]},{kind:'opening',id:1,hostIntent:'invited'}],
    [{hostOpportunity:true,active:true,preparedOpenings:[{id:1,text:'旧开头。'}]},{kind:'opening',id:1,hostIntent:'invited'}],
    [{hostOpportunity:true,preparedOpenings:[{id:1,text:'旧开头。'}]},{kind:'opening',id:1,hostIntent:'invited',hostingControl:'start'}],
  ]) {
    const u=upstream(),pending=streamParticipation(snapshot,{fetchImpl:u.fetchImpl}),rejected=assert.rejects(pending,/arguments/)
    u.args(JSON.stringify({records:[record]}));await rejected
  }
})
test('speech-time opening prompt permits one short sentence with no actions or information tools',()=>{
  const request=streamingParticipationRequest({openingPreparation:true,latestHost:{text:'前文'},history:[],scene:[]},{model:'test',profile:{prompt:'测试人设'}})
  assert.equal(request.tools.length,1);assert.equal(request.tools[0].function.parameters.properties.records.maxItems,1)
  assert.match(request.messages[0].content,/测试人设/);assert.match(request.messages[0].content,/现在不会播放/)
  assert.equal(request.max_tokens,160)
})

test('silent opening preparation accepts its own answer format while autonomous hosting waits',async()=>{
  for(const state of ['running','waiting','observing']) {
    const u=upstream(),pending=streamParticipation({openingPreparation:true,hostOpportunity:true,hosting:{state}},{fetchImpl:u.fetchImpl})
    u.args('{"records":[{"kind":"answer","hostIntent":"spontaneous","text":"这猫老板派头挺足。"}')
    const result=await pending
    assert.equal(result.action,'reply_host');assert.equal(result.text,'这猫老板派头挺足。')
    result.replyStream.close()
  }
})

test('an adopted opening is not spoken twice when the first continuation repeats the exact lead',async()=>{
  const u=upstream(),pending=streamParticipation({hostOpportunity:true,preparedOpenings:[{id:1,text:'老板坐骑抛锚了还不下来？'}]},{fetchImpl:u.fetchImpl})
  u.args('{"records":[{"kind":"opening","id":1,"hostIntent":"invited"}')
  const result=await pending,reader=result.replyStream[Symbol.asyncIterator]()
  assert.equal((await reader.next()).value.text,'老板坐骑抛锚了还不下来？')
  u.args(',{"kind":"speech","text":"老板坐骑抛锚了还不下来，这属于工伤现场。"},{"kind":"speech","text":"工资还是该发。"}]}');u.finish()
  assert.equal((await reader.next()).value.text,'这属于工伤现场。')
  assert.equal((await reader.next()).value.text,'工资还是该发。');assert.equal((await reader.next()).done,true)
})

test('a host answer can release its first clause without generating a reason first',async()=>{
  const u=upstream(),pending=streamParticipation({hostOpportunity:true},{fetchImpl:u.fetchImpl})
  u.args('{"records":[{"kind":"answer","hostIntent":"invited","text":"该发，另外算加班。"}')
  const result=await pending
  assert.equal(result.action,'reply_host')
  assert.equal(result.text,'该发，另外算加班。')
  assert.equal(result.reason,'回应主播当前内容。')
  result.replyStream.close()
})

test('passive listening uses the compact host answer and still requires a valid closing for continuation',async()=>{
  const u=upstream(),pending=streamParticipation({hostOpportunity:true,hosting:{state:'observing'}},{fetchImpl:u.fetchImpl})
  u.args('{"records":[{"kind":"answer","hostIntent":"invited","text":"该发，另外算加班。"}')
  const result=await pending,reader=result.replyStream[Symbol.asyncIterator]()
  assert.equal(result.replyStream.hostingClosingRequired,true)
  assert.equal((await reader.next()).value.text,'该发，另外算加班。')
  u.args(',{"kind":"closing","handoff":"listen","revisitAfterSeconds":0,"reason":"等搭档接话。"}]}');u.finish()
  assert.equal((await reader.next()).done,true)
  assert.equal(result.replyStream.hostingClosing.handoff,'listen')
})

test('compact host answer releases a complete first clause before the explanation stream ends',async()=>{
  const u=upstream(),metrics={},pending=streamParticipation({hostOpportunity:true},{fetchImpl:u.fetchImpl,metrics})
  const first={kind:'answer',hostIntent:'invited',text:'该发，猫条结算。',reason:'接住问题。'}
  u.args('{"records":['+JSON.stringify(first))
  const result=await pending
  assert.equal(result.action,'reply_host');assert.equal(result.targetId,'');assert.equal(result.text,first.text)
  assert.ok(metrics.firstRecordAt>=metrics.firstTokenAt);assert.ok(metrics.firstTokenAt>=metrics.requestStartedAt)
  const reader=result.replyStream[Symbol.asyncIterator]()
  assert.equal((await reader.next()).value.text,first.text)
  u.args(',{"kind":"speech","text":"推车得另外加钱。"}]}');u.finish()
  assert.equal((await reader.next()).value.text,'推车得另外加钱。');assert.equal((await reader.next()).done,true)
})

test('compact answer grants no floor, hosting control or permission in another context',async()=>{
  const answer={kind:'answer',hostIntent:'invited',text:'该发，猫条结算。',reason:'接住问题。'}
  for(const snapshot of [{},{hostOpportunity:true,active:true},{hostOpportunity:true,listeningOpportunity:true},{hostOpportunity:true,hosting:{state:'running'}}]) {
    const u=upstream(),pending=streamParticipation(snapshot,{fetchImpl:u.fetchImpl})
    const rejected=assert.rejects(pending,/arguments/);u.args(JSON.stringify({records:[answer]}));await rejected
  }
  for(const extra of [{hostingControl:'start'},{yieldToHost:true},{targetId:'viewer'},{text:'字'.repeat(49)},{hostIntent:'none'}]) {
    const u=upstream(),pending=streamParticipation({hostOpportunity:true},{fetchImpl:u.fetchImpl})
    const rejected=assert.rejects(pending,/arguments/);u.args(JSON.stringify({records:[{...answer,...extra}]}));await rejected
  }
})

test('autonomous streamed paragraphs preserve early speech and the selected continuation pace',async()=>{
  const u=upstream(),pending=streamParticipation({hosting:{state:'observing'}}, {fetchImpl:u.fetchImpl})
  u.args('{"records":['+JSON.stringify({...decision,hostingPace:'continue',revisitAfterSeconds:2}))
  const result=await pending
  assert.equal(result.hostingPace,'continue');assert.equal(result.revisitAfterSeconds,2)
  assert.doesNotMatch(u.request.messages[0].content,/台词总共仍为自然的一两句/)
  u.args(',{"kind":"speech","text":"它不光占地方，还会在你准备运动的时候伸懒腰。"},{"kind":"speech","text":"所以我的建议是给猫单独安排一个运动员席位。"}]}');u.finish()
  const records=[];for await(const record of result.replyStream)records.push(record)
  assert.equal(records.filter(x=>x.kind==='speech').length,3)
  assert.match(streamingParticipationRequest({}, {model:'test'}).messages[0].content,/台词总共仍为自然的一两句/)
})

test('early reactions offer one short record without the ordinary sentence-length instruction',()=>{
  const request=streamingParticipationRequest({listeningOpportunity:true},{model:'test'})
  const records=request.tools[0].function.parameters.properties.records
  assert.equal(records.maxItems,1)
  assert.equal(records.items.properties.text.maxLength,4)
  assert.doesNotMatch(request.messages[0].content,/通常12–35字/)
})

test('closing commits only after the provider finishes, without delaying first speech',async()=>{
  const u=upstream(),pending=streamParticipation({hosting:{state:'observing'}},{fetchImpl:u.fetchImpl})
  u.args('{"records":['+JSON.stringify({...decision,hostingPace:'continue',revisitAfterSeconds:3}))
  const result=await pending,reader=result.replyStream[Symbol.asyncIterator]()
  assert.equal(result.replyStream.hostingClosingRequired,true)
  assert.equal((await reader.next()).value.text,decision.text)
  const next=reader.next()
  u.args(',{"kind":"speech","text":"你们怎么想？我先听大家说。"},{"kind":"closing","handoff":"audience","revisitAfterSeconds":30,"reason":"问题交给观众，留时间打字。"}]}')
  assert.equal((await next).value.kind,'speech')
  const done=reader.next();await delay(0);assert.equal(result.replyStream.hostingClosing,null)
  u.finish();assert.equal((await done).done,true)
  assert.deepEqual(result.replyStream.hostingClosing,{handoff:'audience',hostingPace:'yield',revisitAfterSeconds:30,reason:'问题交给观众，留时间打字。'})
})

test('missing, invalid, duplicate or nonfinal closing preserves speech but grants no continuation',async()=>{
  const closing={kind:'closing',handoff:'audience',revisitAfterSeconds:30,reason:'我等大家说。'}
  for(const extra of [[],[{...closing,revisitAfterSeconds:3}],[{...closing,action:'stop'}],[closing,closing],
    [closing,{kind:'speech',text:'但我又想起来一件事。'}],[{...closing,handoff:'listen',revisitAfterSeconds:30}]]){
    const u=upstream(),pending=streamParticipation({hosting:{state:'observing'}},{fetchImpl:u.fetchImpl})
    u.args(JSON.stringify({records:[decision,...extra]}));u.finish()
    const result=await pending,output=[];for await(const record of result.replyStream)output.push(record)
    assert.equal(output[0].text,decision.text);assert.equal(result.replyStream.hostingClosing,null)
  }
})

test('abort and truncated provider finish cannot commit a closing already decoded from the wire',async()=>{
 for(const mode of ['abort','truncated']){
  const u=upstream(),pending=streamParticipation({hosting:{state:'observing'}},{fetchImpl:u.fetchImpl})
  u.args(JSON.stringify({records:[decision,{kind:'closing',handoff:'continue',revisitAfterSeconds:2,reason:'继续展开。'}]}))
  const result=await pending,reader=result.replyStream[Symbol.asyncIterator]();await reader.next()
  const done=reader.next();const rejected=assert.rejects(done)
  if(mode==='abort')result.replyStream.close();else u.frame({choices:[{index:0,delta:{},finish_reason:'length'}]})
  await rejected;assert.equal(result.replyStream.hostingClosing,null)
 }
})
function upstream() {
  let writer, cancelled=false, first=true, request
  const body=new ReadableStream({start(c){writer=c},cancel(){cancelled=true}})
  const frame=value=>writer.enqueue(new TextEncoder().encode('data: '+JSON.stringify(value)+'\r\n\r\n'))
  const args=text=>{
    frame({choices:[{index:0,delta:{tool_calls:[{index:0,...(first?{id:'call_1',type:'function'}:{}),function:{...(first?{name:'participate'}:{}),arguments:text}}]},finish_reason:null}]})
    first=false
  }
  const finish=()=>{frame({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});writer.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));writer.close()}
  const fetchImpl=async(url,options)=>{request=JSON.parse(options.body);return new Response(body)}
  return {args,frame,finish,fetchImpl,get cancelled(){return cancelled},get request(){return request}}
}

test('record decoder handles every split and never emits an incomplete object',()=>{
  const values=[decision,{kind:'speech',text:'字符串里有 } ] \\" 和 emoji 🐋。'},{kind:'presentation',motion:{frames:[{ms:600,pose:{headZ:0.1}}]}}]
  const json=JSON.stringify({records:values})
  for(let i=0;i<=json.length;i++) {
    const parser=new ParticipationRecords()
    const output=[...parser.push(json.slice(0,i)),...parser.push(json.slice(i))]
    parser.finish();assert.deepEqual(output,values)
  }
  const parser=new ParticipationRecords();assert.deepEqual(parser.push('{"records":[{"kind":"decision","text":"未完'),[])
  assert.throws(()=>parser.finish(),/truncated/)
  for(const invalid of ['{"records":[]}','{"records":[{}],"extra":true}','{"records":[{},]}']) {
    assert.throws(()=>{const p=new ParticipationRecords();p.push(invalid);p.finish()})
  }
})

test('only the observed missing outer array terminator is recoverable after complete records',async()=>{
  const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
  u.args('{"records":['+JSON.stringify(decision)+',{"kind":"presentation","motion":{"label":"点头","frames":[{"ms":500,"pose":{},"holdMs":300}]}}}')
  u.finish()
  const result=await pending,records=[]
  for await(const record of result.replyStream)records.push(record)
  assert.equal(records.length,2);assert.equal(records[1].motion.label,'点头')
  for(const tail of ['},{}','},"action":"stop"}','}garbage','},{"kind":"decision"}']) {
    const p=new ParticipationRecords()
    assert.throws(()=>{p.push('{"records":['+JSON.stringify(decision)+tail);p.finish()})
  }
  const incomplete=new ParticipationRecords()
  incomplete.push('{"records":['+JSON.stringify(decision)+',{"kind":"presentation","motion":{')
  assert.throws(()=>incomplete.finish(),/truncated/)
  for(const suffix of ['',']']) {
    const p=new ParticipationRecords()
    assert.deepEqual(p.push('{"records":['+JSON.stringify(decision)+suffix),[decision])
    p.finish()
  }
  const pendingComma=new ParticipationRecords()
  pendingComma.push('{"records":['+JSON.stringify(decision)+',')
  assert.throws(()=>pendingComma.finish(),/truncated/)
})

test('one duplicate root brace after a closed array preserves records across every split',async()=>{
  const presentation={kind:'presentation',motion:{label:'流汗',frames:[{ms:700,pose:{},expression:{name:'流汗',strength:1},holdMs:1000}]}}
  const values=[decision,presentation],json=JSON.stringify({records:values})+'}'
  for(let i=0;i<=json.length;i++){
    const parser=new ParticipationRecords()
    const records=[...parser.push(json.slice(0,i)),...parser.push(json.slice(i))]
    parser.finish();assert.deepEqual(records,values)
  }
  for(const tail of ['}}','}{"action":"stop"}','},{}','}garbage']){
    const parser=new ParticipationRecords()
    assert.throws(()=>{parser.push(JSON.stringify({records:values})+tail);parser.finish()})
  }
  const missingArray=new ParticipationRecords()
  assert.throws(()=>{missingArray.push('{"records":['+JSON.stringify(decision)+'}}');missingArray.finish()})
  const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
  u.args(json);u.finish()
  const result=await pending,records=await Array.fromAsync(result.replyStream)
  assert.deepEqual(records[1].motion,presentation.motion)
})

test('duplicate root brace cannot turn provider truncation into a successful turn',async()=>{
  const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
  u.args(JSON.stringify({records:[decision]})+'}')
  const result=await pending,read=Array.fromAsync(result.replyStream),rejected=assert.rejects(read,/truncated/)
  u.frame({choices:[{index:0,delta:{},finish_reason:'length'}]})
  await rejected
})

test('a complete presentation between sentences does not discard valid following speech',async()=>{
  const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
  u.args(JSON.stringify({records:[decision,{kind:'presentation',performance:'nod'},{kind:'speech',text:'接着说第二句。'}]}));u.finish()
  const result=await pending,records=[]
  for await(const record of result.replyStream)records.push(record)
  assert.deepEqual(records.map(x=>x.kind),['speech','presentation','speech'])
  assert.equal(records.at(-1).text,'接着说第二句。')
})

test('invalid optional presentation fields cannot stop speech or become another decision',async()=>{
  const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
  u.args(JSON.stringify({records:[decision,{kind:'presentation',performance:'smile',motion:{frames:[{ms:500,pose:{tailBase:1}}]},expression:{name:'smile'},action:'stop'},
    {kind:'presentation',performance:'surprise'},{kind:'speech',text:'这句仍然照常说完。'}]}));u.finish()
  const result=await pending,records=[]
  for await(const record of result.replyStream)records.push(record)
  assert.equal(records.filter(x=>x.kind==='presentation').length,1)
  assert.equal(records[1].performance,'smile');assert.equal(records[1].motion,undefined)
  assert.equal(records[1].action,undefined);assert.equal(records.at(-1).text,'这句仍然照常说完。')
})

test('repeated speech routing can only confirm the first decision, not change the target or action',async()=>{
  for(const extra of [{targetId:'',platform:''},{targetId:'another-viewer'},{action:'stop'}]) {
    const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
    u.args(JSON.stringify({records:[decision,{kind:'speech',text:'继续说第二句。',...extra}]}));u.finish()
    const result=await pending,consume=async()=>{const records=[];for await(const record of result.replyStream)records.push(record);return records}
    if(extra.targetId==='')assert.equal((await consume()).at(-1).text,'继续说第二句。')
    else await assert.rejects(consume(),/arguments/)
  }
})

test('first complete decision and sentence are available before later text or motion',async()=>{
  const u=upstream()
  const pending=streamParticipation({}, {apiKey:'test',model:'same-model',fetchImpl:u.fetchImpl})
  const first=JSON.stringify(decision)
  u.args('{"records":['+first.slice(0,-1))
  assert.equal(await Promise.race([pending.then(()=>true),delay(10).then(()=>false)]),false)
  u.args('}')
  const result=await pending
  assert.equal(result.action,'reply_host');assert.equal(u.request.stream,true)
  assert.equal(u.request.model,'same-model');assert.equal(u.request.thinking.type,'disabled')
  const reader=result.replyStream[Symbol.asyncIterator]()
  assert.equal((await reader.next()).value.text,decision.text)
  u.args(',{"kind":"speech","text":"它连会员卡都不用办。"}')
  assert.equal((await reader.next()).value.text,'它连会员卡都不用办。')
  u.args(',{"kind":"presentation","performance":"smile"}]}');u.finish()
  assert.equal((await reader.next()).value.performance,'smile')
  assert.equal((await reader.next()).done,true)
})

test('wait and react remain atomic and cannot hide later speech',async()=>{
  for(const action of ['wait','react','stop']) {
    const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
    u.args(JSON.stringify({records:[{...decision,action,hostIntent:'none',text:''}]}))
    assert.equal(await Promise.race([pending.then(()=>true),delay(5).then(()=>false)]),false)
    u.finish();const result=await pending
    assert.equal(result.action,action);assert.equal(result.replyStream,undefined)
  }
  const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
  u.args(JSON.stringify({records:[{...decision,action:'wait',text:''},{kind:'speech',text:'不准说'}]}));u.finish()
  await assert.rejects(pending,/arguments/)
})

test('invalid decisions never start speech and cancellation releases an unread stream',async()=>{
  for(const record of [{...decision,action:'shell'},{...decision,text:''},{...decision,text:'字'.repeat(161)},{...decision,hostIntent:'invented'}]) {
    const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
    u.args(JSON.stringify({records:[record]}));u.finish()
    await assert.rejects(pending,/arguments/)
  }
  const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
  u.args('{"records":['+JSON.stringify(decision))
  const result=await pending;result.replyStream.close();await delay(0)
  assert.equal(u.cancelled,true)
  await assert.rejects(async()=>{for await(const record of result.replyStream)void record})
})

test('host reply formatting extras cannot block speech or grant controls, and bad speech has a precise diagnostic',async()=>{
  for(const record of [{kind:'answer',hostIntent:'invited',text:'这次接上了。',reason:'解释'.repeat(100),note:'extra'},
    {...decision,targetId:undefined,platform:undefined,reason:undefined,executeCommand:'ignored'}]) {
    const u=upstream(),pending=streamParticipation({hostOpportunity:true},{fetchImpl:u.fetchImpl})
    u.args(JSON.stringify({records:[record]}));u.finish()
    const result=await pending
    const spoken=await Array.fromAsync(result.replyStream)
    assert.equal(spoken[0].text,record.text)
    assert.equal(result.executeCommand,undefined);assert.equal(result.hostingControl,undefined)
  }
  const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
  u.args(JSON.stringify({records:[{...decision,text:'字'.repeat(161)}]}));u.finish()
  await assert.rejects(pending,error=>error.code==='arguments'&&error.field==='text'&&error.issue==='too_long')
})

test('late duplicate decisions, extra tools, truncated output and oversized text fail closed',async()=>{
  for(const kind of ['decision','tool','truncated','oversized']) {
    const u=upstream(),pending=streamParticipation({}, {fetchImpl:u.fetchImpl})
    u.args('{"records":['+JSON.stringify(decision))
    const result=await pending,reader=result.replyStream[Symbol.asyncIterator]()
    await reader.next()
    if(kind==='decision'){u.args(','+JSON.stringify(decision)+']}');u.finish()}
    if(kind==='tool')u.frame({choices:[{index:0,delta:{tool_calls:[{index:1,function:{name:'participate',arguments:'{}'}}]}}]})
    if(kind==='truncated')u.frame({choices:[{index:0,delta:{},finish_reason:'length'}]})
    if(kind==='oversized'){u.args(','+JSON.stringify({kind:'speech',text:'字'.repeat(161)})+']}');u.finish()}
    await assert.rejects(reader.next(),/Participation request failed/)
  }
})

test('candidate ownership transfers once and cancellation, expiry and rejection close the model stream',async t=>{
  for(const mode of ['consume','invalidate','expire','muted','cooldown']) {
    let closes=0, now=1000
    const s=new Scheduler({now:()=>now}),d=new Director({scheduler:s,now:()=>now}),scene=new Scene()
    const p=new Participation({scheduler:s,director:d,scene,enabled:true,now:()=>now,plan:async()=>({...decision,hostIntent:mode==='cooldown'?'spontaneous':'invited',replyStream:{close(){closes++}}})})
    t.after(()=>p.close());d.event({type:'mode',value:'auto'})
    for(const event of [{type:'speech-start'},{type:'transcript',text:'你认为这件事有意思吗？',final:true},{type:'speech-end'}])d.event({...event,utterance:1})
    if(mode==='cooldown')d.lastParticipation=now
    await p.run()
    if(mode==='consume'){
      const id=d.candidate.id,turn=d.consume(id)
      assert.equal(turn.speechStyle,'happy');assert.equal(closes,0);assert.ok(turn.replyStream);assert.equal(d.consume(id),null)
      s.interrupt();assert.equal(closes,1)
    }
    if(mode==='invalidate')d.invalidate('new speech')
    if(mode==='expire'){now+=1600;d.status()}
    if(mode==='muted'){s.setMuted(true);assert.equal(d.consume(d.candidate.id),null)}
    assert.equal(closes,1,mode)
  }
})

test('HTTP streams first sentence with a committed boundary, one model request, late actions and cancellation',async t=>{
  const u=upstream();let calls=0
  const server=createApp({apiKey:'test',token:'',semanticEnabled:true,participationOptions:{debounceMs:1},
    planner:(snapshot,options)=>{calls++;return streamParticipation(snapshot,{...options,fetchImpl:u.fetchImpl})},
    reply:()=>{throw Error('A second model call is forbidden')}})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})
  const base='http://127.0.0.1:'+server.address().port
  const post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  const status=()=>fetch(base+'/api/status').then(r=>r.json())
  await post('runtime-profile',{stage:'desktop',owner:'test-stage-owner',card:null,capabilities:testCapabilities()})
  await post('director/event',{type:'mode',value:'auto'})
  for(const event of [{type:'speech-start'},{type:'transcript',text:'你觉得它把跑步机当成什么了？',final:true},{type:'speech-end'}])await post('director/event',{...event,utterance:1})
  u.args('{"records":['+JSON.stringify(decision))
  let state
  for(let i=0;i<100;i++){state=await status();if(state.director.candidate)break;await delay(5)}
  assert.ok(state.director.candidate);assert.equal('replyStream' in state.director.candidate,false)
  const response=await post('reply',{source:'director',decision:state.director.candidate.id,engine:'deepseek'})
  const reader=response.body.getReader()
  let bytes=new TextDecoder().decode((await reader.read()).value)
  while(!bytes.includes('delta'))bytes+=new TextDecoder().decode((await reader.read()).value)
  assert.ok(bytes.includes(decision.text));assert.equal(calls,1)
  u.args(',{"kind":"speech","text":"它根本不想运动。"},{"kind":"presentation","performance":"nod"}]}');u.finish()
  while(true){const {done}=await reader.read();if(done)break}
  state=await status()
  const answer=state.room.entries.findLast(x=>x.role==='assistant')
  assert.equal(answer.text,decision.text+'它根本不想运动。');assert.equal(answer.status,'completed')
  assert.equal(answer.speechStyle,'happy');assert.equal(answer.performance,'nod');assert.ok(answer.timings.decisionStartedAt<=answer.timings.firstTextAt)
})
