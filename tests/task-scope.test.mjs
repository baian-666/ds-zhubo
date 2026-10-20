import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskScope } from '../apps/cohost/task-scope.mjs'
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}

test('lookup deadline extension is capped from creation and cannot revive a cancelled task',async t=>{
  const tasks=scope(t),work=deferred();let extend
  const task=tasks.start({key:'lookup',kind:'review',timeoutMs:20,maxTimeoutMs:80,run:options=>{extend=options.extendTimeout;return work.promise}})
  assert.equal(extend(100),false);assert.equal(extend(10),false);assert.equal(extend(80),true)
  await delay(30);assert.equal(task.state,'running')
  task.cancel();assert.equal(extend(80),false);work.resolve('late')
  assert.equal((await task.done).state,'cancelled')
})
function scope(t,options={}) {const tasks=new TaskScope({name:'test-owner',pollMs:2,...options});t.after(()=>tasks.close());return tasks}

test('waiting jobs coalesce, gate on idle, and expose only bounded metadata',async t=>{
  const tasks=scope(t,{historyLimit:2}),work=deferred();let idle=false,calls=0
  const options={key:'private-key',kind:'summary',ready:()=>idle,run:()=>{calls++;return work.promise}}
  const job=tasks.start(options)
  assert.equal(tasks.start(options),job);assert.equal(job.state,'waiting');assert.equal(calls,0)
  idle=true;tasks.pump();assert.equal(job.state,'running');assert.equal(calls,1)
  work.resolve('PRIVATE_RESULT');assert.equal((await job.done).value,'PRIVATE_RESULT')
  for(let n=0;n<4;n++)await tasks.start({key:String(n),kind:'failure',run:()=>{throw Error('PRIVATE_ERROR')}}).done
  const state=tasks.status();assert.equal(state.recent.length,2)
  assert.equal(JSON.stringify(state).includes('PRIVATE'),false)
  assert.equal(JSON.stringify(state).includes('private-key'),false)
})

test('cancellation releases the caller but bounds workers ignoring abort and disposes late streams',async t=>{
  const tasks=scope(t,{maxRunning:2,maxWaiting:1}),first=deferred(),second=deferred();let discarded=0,queuedCalls=0
  const old=tasks.start({key:'first',kind:'review',run:()=>first.promise,discard:value=>value.close()})
  old.cancel('superseded');assert.equal((await old.done).state,'cancelled');assert.equal(old.controller.signal.aborted,true)
  const next=tasks.start({key:'second',kind:'review',run:()=>second.promise})
  next.cancel();await next.done
  const queued=tasks.start({key:'third',kind:'review',run:()=>{queuedCalls++;return 'fresh'}})
  assert.equal(queued.state,'waiting')
  const overflow=await tasks.start({key:'fourth',kind:'review',run:()=>assert.fail('overflow ran')}).done
  assert.equal(overflow.reason,'capacity');assert.equal(tasks.status().draining,2)
  first.resolve({close(){discarded++}})
  assert.equal((await queued.done).value,'fresh');assert.equal(queuedCalls,1);assert.equal(discarded,1)
  second.reject(Error('late provider error'));await delay(0)
  assert.equal(tasks.status().draining,0)
})

test('timeout aborts both running and queued work and cleans late resources exactly once',async t=>{
  const tasks=scope(t),work=deferred();let closed=0
  const job=tasks.start({key:'first',kind:'review',run:()=>work.promise,timeoutMs:10,discard:()=>{closed++}})
  const queued=tasks.start({key:'second',kind:'review',run:()=>assert.fail('queued work ran'),timeoutMs:10})
  assert.equal((await job.done).reason,'timeout');assert.equal((await queued.done).reason,'timeout')
  assert.equal(job.controller.signal.aborted,true)
  work.resolve('late');await delay(0);assert.equal(closed,1)
  assert.equal(job.cancel(),false);assert.equal(closed,1)
})

test('reset cancels the whole old generation before pumping and a fresh generation remains usable',async t=>{
  const tasks=scope(t),work=deferred(),oldGeneration=tasks.generation
  const active=tasks.start({key:'a',kind:'summary',run:()=>work.promise})
  const waiting=tasks.start({key:'b',kind:'summary',run:()=>assert.fail('old generation started')})
  tasks.reset();assert.notEqual(tasks.generation,oldGeneration)
  assert.equal((await active.done).state,'cancelled');assert.equal((await waiting.done).state,'cancelled')
  work.resolve();await delay(0)
  const fresh=tasks.start({key:'a',kind:'summary',run:()=>42})
  assert.equal((await fresh.done).value,42)
  tasks.close();tasks.close();assert.equal(tasks.timer,null)
  assert.equal((await tasks.start({key:'c',kind:'summary',run:()=>assert.fail('closed task ran')}).done).reason,'closed')
})

test('parent abort, synchronous throw and cleanup failure remain contained in their scope',async t=>{
  const tasks=scope(t),other=scope(t),parent=new AbortController(),work=deferred()
  const job=tasks.start({key:'a',kind:'summary',signal:parent.signal,run:()=>work.promise,discard:async()=>{throw Error('cleanup failed')}})
  parent.abort();assert.equal((await job.done).reason,'parent')
  work.resolve({});await delay(0)
  const failed=await tasks.start({key:'b',kind:'summary',run:()=>{throw Error('worker failed')}}).done
  assert.equal(failed.state,'failed')
  assert.equal((await other.start({key:'independent',kind:'review',run:()=>7}).done).value,7)
  const cancelled=tasks.start({key:'c',kind:'summary',signal:parent.signal,run:()=>assert.fail('aborted task started')})
  assert.equal((await cancelled.done).state,'cancelled')
})
