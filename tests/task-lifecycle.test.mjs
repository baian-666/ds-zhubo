import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../apps/cohost/server.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'

async function app(t,options={}) {
  const server=createApp({apiKey:'fixture',token:'private-test-token',...options})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Bearer private-test-token','Content-Type':'application/json'}
  return {server,base,get:path=>fetch(base+'/api/'+path,{headers}),post:(path,body)=>fetch(base+'/api/'+path,{headers,method:'POST',body:JSON.stringify(body)})}
}
async function until(fn) {for(let n=0;n<100;n++){const value=await fn();if(value)return value;await delay(5)}throw Error('condition did not settle')}
async function host(api,id,text) {for(const body of [{type:'speech-start'},{type:'transcript',text,final:true},{type:'speech-end'}])assert.equal((await api.post('director/event',{...body,utterance:id})).status,200)}

test('task diagnostics require authorization and maintenance never makes the output busy',async t=>{
  const a=await app(t,{semanticEnabled:false})
  assert.equal((await fetch(a.base+'/api/tasks')).status,401)
  await host(a,1,'这是主播正在讲的一段话。')
  const tasks=await(await a.get('tasks')).json(),status=await(await a.get('status')).json()
  assert.equal(tasks.maintenance.waiting,1);assert.equal(status.busy,false)
  assert.equal(tasks.participation.running,0)
  assert.equal(JSON.stringify(tasks).includes('这是主播'),false)
  assert.equal(JSON.stringify(tasks).includes('private-test-token'),false)
})

test('closing the server cancels producers before status sockets close and rejects a late stream',async t=>{
  let finish,signal,closed=0
  const scheduler=new Scheduler(),director=new Director({scheduler})
  const a=await app(t,{scheduler,director,semanticEnabled:true,participationOptions:{debounceMs:1},
    planner:(_,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve})}})
  await a.post('director/event',{type:'mode',value:'auto'});await host(a,1,'你说这事有意思吗？')
  await until(()=>finish)
  const response=await a.get('status/events'),reader=response.body.getReader();await reader.read()
  const stopped=new Promise(resolve=>a.server.close(resolve))
  assert.equal(signal.aborted,true,'cancellation occurs when close is requested, not after socket drain')
  try {while(!(await reader.read()).done){}} catch(error) {assert.equal(error.cause?.code,'UND_ERR_SOCKET')}
  await stopped
  const count=director.trace.length
  finish({action:'reply_host',hostIntent:'invited',reason:'迟到',text:'过期答案',replyStream:{close(){closed++}}})
  await until(()=>closed===1)
  assert.equal(director.trace.length,count);assert.equal(scheduler.active,null);assert.equal(director.candidate,null)
})

test('reset cancels old planning, preserves fresh input and leaves manual replies available',async t=>{
  const jobs=[]
  const a=await app(t,{semanticEnabled:true,participationOptions:{debounceMs:1},
    planner:(_,options)=>new Promise(resolve=>jobs.push({resolve,signal:options.signal})),reply:async function*(){yield '新话轮正常。'}})
  await a.post('director/event',{type:'mode',value:'auto'});await host(a,1,'这件事情你说呢？');await until(()=>jobs.length===1)
  const before=await(await a.get('status')).json();await a.post('reset',{session:before.room.session})
  assert.equal(jobs[0].signal.aborted,true)
  await host(a,2,'这是另一个话题，你怎么看？');await until(()=>jobs.length===2)
  let closed=0;jobs[0].resolve({action:'reply_host',reason:'旧决定',text:'旧话轮',replyStream:{close(){closed++}}});await until(()=>closed===1)
  const response=await a.post('reply',{source:'host',text:'请回答现在的问题',engine:'deepseek'})
  assert.equal(response.status,200);assert.ok((await response.text()).includes('新话轮正常'))
  jobs[1].resolve({action:'wait',reason:'等一下',text:''});await delay(0)
  const after=await(await a.get('status')).json();assert.equal(after.room.entries.some(e=>e.text==='旧话轮'),false)
})
