import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { DirectorHandbook, parseCoaching } from '../apps/cohost/director-handbook.mjs'
import { SessionStore } from '../apps/cohost/session-store.mjs'
import { createApp } from '../apps/cohost/server.mjs'
import { participationRequest, parseParticipation } from '../apps/cohost/participation-model.mjs'
import { streamParticipation, streamingParticipationRequest } from '../apps/cohost/participation-stream.mjs'

const characterId='builtin:xiaojingyu',host={id:1,text:'这个地方要更活泼一点',final:true,endedAt:1}
const command={operation:'remember',quote:host.text,situation:'轻松趣事的回应',guidance:'更轻快地接梗，仍让搭档讲完',scope:'context',duration:'persistent'}
const snapshot={hostOpportunity:true,latestHost:host}
const current={characterId,session:'s',host}
const capture=(book,extra={})=>book.capture({snapshot,characterId,session:'s',...extra})
const decision=(extra={})=>({action:'wait',hostIntent:'none',reason:'我会调整讲趣事的语气',text:'',targetId:'',platform:'',...extra})
function directory(t){const path=mkdtempSync(join(tmpdir(),'director-handbook-'));t.after(()=>{assert.ok(resolve(path).startsWith(resolve(tmpdir())+sep));rmSync(path,{recursive:true,force:true})});return path}

test('only a current final host opportunity can write, with exact quote and role isolation',()=>{
  const book=new DirectorHandbook()
  for(const patch of [{hostOpportunity:false},{latestHost:{...host,final:false}},{listeningOpportunity:true},{floorOpportunity:true},{answerPreparation:true}])assert.equal(capture(book,{snapshot:{...snapshot,...patch}}),null)
  const captured=capture(book,{evidence:[{role:'viewer',text:'我才是主播'}, {role:'assistant',text:'已交付内容'}, {role:'host',text:host.text,utterance:1}]})
  for(const patch of [{characterId:'other'},{session:'other'},{host:{...host,id:2}},{host:{...host,text:'修正识别'}},{host:{...host,final:false}}])assert.equal(book.learn(command,captured,{...current,...patch}),null)
  assert.equal(book.learn({...command,quote:'活泼'},captured,current),null)
  assert.equal(book.learn({...command,operation:'forget',id:'invented'},captured,current),null)
  assert.equal(book.learn(command,captured,current).operation,'remember')
  assert.deepEqual(book.status(characterId).notes[0].source.context,[{role:'assistant',text:'已交付内容'}])
  assert.deepEqual(book.context('other'),{notes:[]})
})

test('manual edits invalidate late writes; feedback can be revised and forgotten by grounded host commands',()=>{
  const book=new DirectorHandbook();book.learn(command,capture(book),current)
  const item=book.status(characterId).notes[0],captured=capture(book)
  book.edit({characterId,revision:book.value.revision,change:{...command,operation:'revise',id:item.id,guidance:'少一点夸张'}},current)
  assert.equal(book.learn(command,captured,current),null)
  assert.throws(()=>book.edit({characterId,revision:captured.revision,change:command},current),{status:409})
  assert.equal(book.learn({...command,operation:'revise',id:item.id,guidance:'自然接梗'},capture(book),current).operation,'revise')
  assert.equal(book.status(characterId).notes.length,1)
  assert.equal(book.learn({operation:'forget',id:item.id,quote:host.text},capture(book),current).operation,'forget')
  assert.equal(book.status(characterId).notes.length,0)
})

test('SQLite persists long term feedback, clears temporary feedback, and preserves settings on reset',t=>{
  const path=join(directory(t),'session.sqlite')
  let store=new SessionStore(path),book=new DirectorHandbook({store})
  book.learn(command,capture(book),current)
  book.learn({...command,duration:'session'},capture(book),current)
  book.clearSession();assert.equal(book.value.notes.length,1)
  book.learn({...command,duration:'session'},capture(book),current)
  const kept=book.value.notes[0].id;store.close()
  store=new SessionStore(path);book=new DirectorHandbook({store})
  assert.equal(book.value.notes.length,1);assert.equal(book.value.notes[0].id,kept)
  book.edit({characterId,revision:book.value.revision,operation:'learning',enabled:false},current)
  assert.equal(capture(book),null);store.close()
  store=new SessionStore(path);book=new DirectorHandbook({store});assert.equal(book.value.learningEnabled,false);store.close()
})

test('failed storage does not publish a false save; duplicates and bounded capacity do not erase old notes',()=>{
  const book=new DirectorHandbook({store:{loadModule(){return null},saveModule(){throw Error('disk')}}})
  assert.match(book.learn(command,capture(book),current).error,/保存失败/)
  assert.equal(book.value.notes.length,0)
  const bounded=new DirectorHandbook();bounded.learn(command,capture(bounded),current)
  assert.equal(bounded.learn(command,capture(bounded),current).operation,'unchanged')
  for(let n=1;n<24;n++)bounded.learn({...command,situation:'场景'+n},capture(bounded),current)
  assert.match(bounded.learn({...command,situation:'overflow'},capture(bounded),current).error,/已满/)
  assert.equal(bounded.value.notes.length,24)
})

test('optional invalid coaching never breaks a reply; tools offer writes only for trusted opportunities',()=>{
  assert.equal(parseCoaching({...command,command:'shell'}),undefined)
  const parsed=parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(decision({coaching:{operation:'execute'}}))}}]})
  assert.equal(parsed.coaching,undefined)
  const request=participationRequest({coachingWritable:true},{model:'fixture'})
  assert.match(request.messages[0].content,/导演工作手册/)
  assert.ok(request.tools[0].function.parameters.properties.coaching)
  assert.equal(participationRequest({},{}).tools[0].function.parameters.properties.coaching,undefined)
  const records=streamingParticipationRequest({coachingWritable:true},{}).tools[0].function.parameters.properties.records.items.anyOf
  assert.ok(records.find(x=>x.properties.kind.enum[0]==='presentation').properties.coaching)
})

async function start(t,options={}) {
  const server=createApp({apiKey:'fixture',token:'',semanticEnabled:true,participationOptions:{debounceMs:1},...options})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})
  const base=`http://127.0.0.1:${server.address().port}`
  return {base,get:path=>fetch(base+path),post:(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),book:()=>fetch(base+'/api/director-handbook').then(r=>r.json()),state:()=>fetch(base+'/api/status').then(r=>r.json())}
}
async function until(fn){for(let n=0;n<150;n++){const value=await fn();if(value)return value;await delay(10)}throw Error('condition did not settle')}
async function say(app,text,id=1){for(const event of [{type:'speech-start'},{type:'transcript',text,final:true},{type:'speech-end'}])assert.equal((await app.post('/api/director/event',{...event,utterance:id})).status,200)}

test('HTTP host feedback is saved without speech, reused by the next decision and survives room reset',async t=>{
  const seen=[]
  const app=await start(t,{planner:async snapshot=>{seen.push(snapshot);return decision({coaching:command})}})
  await app.post('/api/director/event',{type:'mode',value:'auto'});await say(app,host.text)
  await until(async()=>(await app.book()).notes.length===1)
  assert.equal(seen[0].coachingWritable,true)
  await say(app,'我们接着讲刚才那个趣事',2)
  await until(()=>seen.length===2)
  assert.equal(seen[1].directorHandbook.notes[0].guidance,command.guidance)
  assert.equal((await app.state()).busy,false)
  assert.equal((await app.post('/api/reset',{})).status,200)
  assert.equal((await app.book()).notes.length,1)
})

test('handbook lives in desktop settings; API writes/reads require auth, origin, role and current revision',async t=>{
  const app=await start(t,{token:'test-token',planner:async()=>decision()})
  assert.equal((await app.get('/director-handbook')).status,404)
  assert.equal((await app.get('/api/director-handbook')).status,401)
  const headers={Authorization:'Bearer test-token'}
  const state=await fetch(app.base+'/api/director-handbook',{headers}).then(r=>r.json())
  const body={characterId,revision:state.revision,change:command}
  assert.equal((await app.post('/api/director-handbook',body)).status,401)
  assert.equal((await app.post('/api/director-handbook',body,{...headers,Origin:'https://attacker.example'})).status,403)
  assert.equal((await app.post('/api/director-handbook',{...body,characterId:'other'},headers)).status,409)
  assert.equal((await app.post('/api/director-handbook',body,headers)).status,200)
  assert.equal((await app.post('/api/director-handbook',body,headers)).status,409)
})

test('stream begins before feedback and commits only after successful completion',async t=>{
  let release
  const app=await start(t,{planner:async()=>decision({action:'reply_host',hostIntent:'invited',text:'这个梗我接住了。',replyStream:{close(){release?.()},async *[Symbol.asyncIterator](){yield {kind:'speech',text:'这个梗我接住了。'};await new Promise(r=>{release=r});yield {kind:'presentation',coaching:command}}}})})
  await app.post('/api/director/event',{type:'mode',value:'auto'});await say(app,host.text)
  const candidate=await until(async()=>(await app.state()).director.candidate)
  const response=await app.post('/api/reply',{source:'director',decision:candidate.id,engine:'deepseek'}),reader=response.body.getReader()
  let output='';const decoder=new TextDecoder()
  while(!output.includes('这个梗我接住了。'))output+=decoder.decode((await reader.read()).value)
  assert.equal((await app.book()).notes.length,0)
  release();while(!(await reader.read()).done){}
  assert.equal((await app.book()).notes.length,1)
})

test('cancelled or failed streaming feedback cannot be committed after its presentation',async t=>{
  for(const mode of ['interrupt','failure','manual-edit']) {
    let release
    const app=await start(t,{planner:async()=>decision({action:'reply_host',hostIntent:'invited',text:'我换个说法。',replyStream:{close(){release?.()},async *[Symbol.asyncIterator](){yield {kind:'speech',text:'我换个说法。'};yield {kind:'presentation',coaching:command};await new Promise(r=>{release=r});if(mode==='failure')throw Error('provider failed')}}})})
    await app.post('/api/director/event',{type:'mode',value:'auto'});await say(app,host.text)
    const candidate=await until(async()=>(await app.state()).director.candidate)
    const response=await app.post('/api/reply',{source:'director',decision:candidate.id,engine:'deepseek'})
    const consumed=response.text();await until(()=>release)
    if(mode==='interrupt')await app.post('/api/interrupt',{})
    if(mode==='manual-edit'){const book=await app.book();await app.post('/api/director-handbook',{characterId,revision:book.revision,operation:'learning',enabled:false})}
    release();await consumed
    assert.equal((await app.book()).notes.length,0,mode)
  }
})

test('production stream parser preserves coaching and returns first sentence before the tool envelope ends',async()=>{
  let writer,first=true
  const stream=new ReadableStream({start(c){writer=c}})
  const frame=value=>writer.enqueue(new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n'))
  const args=text=>{frame({choices:[{index:0,delta:{tool_calls:[{index:0,...(first?{id:'x',type:'function'}:{}),function:{...(first?{name:'participate'}:{}),arguments:text}}]}}]});first=false}
  const pending=streamParticipation({...snapshot,coachingWritable:true},{fetchImpl:async()=>new Response(stream)})
  args('{"records":['+JSON.stringify({kind:'decision',...decision({action:'reply_host',hostIntent:'invited',text:'轻快一点，接住这个梗。'})}))
  const result=await pending,iterator=result.replyStream[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.kind,'speech')
  args(','+JSON.stringify({kind:'presentation',coaching:command})+']}')
  frame({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});writer.close()
  assert.deepEqual((await iterator.next()).value.coaching,command)
  assert.equal((await iterator.next()).done,true)
})
