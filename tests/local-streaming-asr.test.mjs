import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { LocalStreamingAsr } from '../apps/cohost/local-streaming-asr.mjs'

async function setup() {
  const child=new EventEmitter(), sent=[]
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough()
  child.stdin.on('data',data=>sent.push(...String(data).trim().split('\n').map(JSON.parse)))
  child.kill=()=>{child.killed=true}
  let starts=0
  const pool=new LocalStreamingAsr({python:'python',modelDir:'model',runtimeDir:'runtime',spawnImpl:()=>{starts++;return child}})
  const ready=pool.prepare();child.stdout.write(JSON.stringify({type:'ready'})+'\n');await ready
  return {pool,child,sent,starts:()=>starts,emit:value=>child.stdout.write(JSON.stringify(value)+'\n')}
}

test('local decoder consumes actual ordered PCM, permits revisions and delivers only one endpoint final',async()=>{
  const {pool,sent,emit}=await setup(),events=[]
  try {
    const task=pool.open({emit:event=>events.push(event)})
    assert.equal(events.length,0,'open must return before emitting the first HTTP body frame')
    await task.ready
    assert.equal(events[0].type,'ready')
    task.write(Buffer.from([3,0,4,0]),0)
    assert.deepEqual(Buffer.from(sent.find(e=>e.type==='audio').pcm,'base64'),Buffer.from([3,0,4,0]))
    assert.throws(()=>task.write(Buffer.alloc(2),0),/乱序/)
    emit({id:task.id,type:'partial',text:'小金鱼'})
    emit({id:task.id,type:'partial',text:'小鲸鱼'})
    emit({id:task.id,type:'final',text:'未结束时不能交付'})
    assert.equal(events.some(e=>e.type==='final'),false)
    assert.throws(()=>task.finish(3),/顺序/)
    const done=task.finish(1)
    emit({id:task.id,type:'final',text:'小鲸鱼你觉得呢'})
    emit({id:task.id,type:'final',text:'迟到'})
    assert.equal((await done).text,'小鲸鱼你觉得呢')
    assert.equal(events.filter(e=>e.type==='final').length,1)
    assert.equal(pool.segments.size,0)
  } finally {pool.clear()}
})

test('cancelled segments discard late local results; stopping capture kills the worker and all decoders',async()=>{
  const {pool,child,emit,starts}=await setup(),events=[],controller=new AbortController()
  const first=pool.open({signal:controller.signal,emit:e=>events.push(e)}),second=pool.open({})
  await first.ready
  controller.abort();emit({id:first.id,type:'partial',text:'过期'})
  await assert.rejects(first.done,/取消/)
  assert.deepEqual(events.map(e=>e.type),['ready'])
  pool.clear();await assert.rejects(second.done,/停止/)
  assert.equal(child.killed,true);assert.equal(pool.segments.size,0);assert.equal(starts(),1)
})

test('worker failure rejects pending recognition without inventing a final transcript or restarting',async()=>{
  const {pool,child,starts}=await setup(),events=[]
  const task=pool.open({emit:e=>events.push(e)})
  child.emit('exit',1)
  await assert.rejects(task.done,/退出/)
  assert.equal(events.some(e=>e.type==='final'),false)
  assert.throws(()=>pool.open({}),/尚未就绪/)
  assert.equal(starts(),1)
})
