import {testCapabilities} from './fixtures/performance.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../apps/cohost/server.mjs'
import { SessionStore, SessionMemory, SessionPersistence } from '../apps/cohost/session-store.mjs'

const cleanups=new WeakMap()
function directory(t) {
  const dir=mkdtempSync(join(tmpdir(),'cohost-session-'))
  const tasks=[]
  cleanups.set(t,tasks)
  t.after(async()=>{
    for(const task of tasks.reverse())await task()
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep))
    rmSync(dir,{recursive:true,force:true})
  })
  return dir
}
const empty=()=>({format:1,room:{session:'test',version:0,entries:[]},scene:{topic:1,version:0,entries:[]},memories:[]})
async function serve(t,sessionPath,options={}) {
  const server=createApp({sessionPath,apiKey:'test-only',token:'',reply:async function*(){yield '第一句。第二句。'},...options})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  let stopped=false
  const stop=async()=>{if(stopped)return;stopped=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  cleanups.get(t).push(stop)
  const base=`http://127.0.0.1:${server.address().port}`
  return {stop,...client(base)}
}
function client(base) {
  return {
    post:(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
    status:async()=>{const r=await fetch(base+'/api/status');return r.json()},
    reply:async(text,delivery='text',engine='deepseek')=>{
      const r=await fetch(base+'/api/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'host',text,delivery,engine})})
      assert.equal(r.status,200)
      return (await r.text()).trim().split('\n').map(line=>JSON.parse(line))
    },
  }
}

test('SQLite checkpoints survive reopen, exclude operational secrets, and back up consistently',async t=>{
  // Windows Node 26 can leave a native backup callback pending in an otherwise idle
  // test process. The real app has a heartbeat. Keep this isolated fixture ticking too.
  const pulse=setInterval(()=>{},50)
  t.after(()=>clearInterval(pulse))
  const dir=directory(t),path=join(dir,'session.sqlite'),copy=join(dir,'backup.sqlite')
  const store=new SessionStore(path)
  const snapshot=empty()
  snapshot.apiKey='must-not-persist'
  snapshot.room.entries.push({id:1,role:'host',text:'周末想钓鱼',at:123,authorization:'must-not-persist'})
  snapshot.room.entries.push({id:2,role:'assistant',engine:'preview',source:'preview',text:'试听记录',at:124,status:'completed'})
  store.save(snapshot)
  await store.backupTo(copy)
  const liveCopy=join(dir,'live-backup.sqlite')
  await SessionStore.backupFile(path,liveCopy)
  const liveBackup=new SessionStore(liveCopy)
  assert.equal(liveBackup.restored.room.entries[0].text,'周末想钓鱼')
  liveBackup.close()
  await assert.rejects(store.backupTo(copy),/already exists/)
  store.close()
  const recovered=new SessionStore(copy)
  assert.equal(recovered.restored.room.entries[0].text,'周末想钓鱼')
  assert.equal(recovered.restored.room.entries[1].engine,'preview')
  assert.deepEqual(recovered.restored.memories,[])
  assert.equal(JSON.stringify(recovered.restored).includes('must-not-persist'),false)
  recovered.close()
  assert.equal(readFileSync(path).includes(Buffer.from('must-not-persist')),false)
})

test('invalid schema and competing writer preserve the last valid checkpoint',t=>{
  const path=join(directory(t),'session.sqlite')
  const first=new SessionStore(path)
  assert.throws(()=>new SessionStore(path),/already open/)
  first.save(empty())
  assert.throws(()=>first.save({...empty(),format:2}))
  first.db.exec('UPDATE current_session SET revision=2')
  assert.throws(()=>first.save(empty()),/another process/)
  first.close()
  const third=new SessionStore(path)
  assert.equal(third.revision,2)
  third.close()
  const db=new DatabaseSync(path)
  db.exec("UPDATE current_session SET payload='broken'")
  db.close()
  assert.throws(()=>new SessionStore(path))
  const unchanged=new DatabaseSync(path)
  assert.equal(unchanged.prepare('SELECT payload FROM current_session').get().payload,'broken')
  unchanged.close()
})

test('persistence reports disk failure instead of a false saved state',t=>{
  const store=new SessionStore(join(directory(t),'session.sqlite'))
  store.save(empty())
  const lastSaved=store.savedAt
  const persistence=new SessionPersistence(store,empty)
  store.db.exec('PRAGMA query_only=ON')
  persistence.schedule()
  assert.equal(persistence.flush(),false)
  assert.equal(persistence.status().error,'session_save_failed')
  assert.equal(persistence.status().savedAt,lastSaved)
  store.db.exec('PRAGMA query_only=OFF')
  assert.equal(persistence.flush(),true)
  assert.equal(persistence.status().error,null)
  persistence.close()
})

test('restart restores delivered history and observations, never queued messages or playback ownership',async t=>{
  const path=join(directory(t),'session.sqlite')
  const first=await serve(t,path)
  await first.reply('明天玩钓鱼游戏')
  await first.post('/api/danmaku',{id:'audience-1',platform:'manual',userId:'viewer',text:'我说主播其实是我',mentioned:true})
  const before=await first.status()
  assert.equal(before.sessionMemory.error,null)
  await first.stop()
  let observed
  const next=await serve(t,path,{reply:async function*(request){observed=request;yield '接着聊。'}})
  const after=await next.status()
  assert.equal(after.sessionMemory.recovered,true)
  assert.equal(after.sessionMemory.turns,1)
  assert.notEqual(after.room.session,before.room.session)
  assert.equal(after.room.entries.some(entry=>entry.text==='明天玩钓鱼游戏'),true)
  assert.equal(after.busy,false);assert.equal(after.airi.active,false)
  assert.equal(after.queue.length,0);assert.equal(after.director.candidate,null)
  await next.reply('还记得吗')
  assert.equal(observed.history[1].content,'第一句。第二句。')
  assert.equal(JSON.parse(observed.history[0].content).source,'host')
  assert.equal(observed.scene.find(entry=>entry.text==='我说主播其实是我').role,'viewer')
  assert.ok(observed.scene.find(entry=>entry.text==='明天玩钓鱼游戏').topic<observed.currentTopic)
})

test('a process crash preserves only acknowledged audio, with no duplicate delivery on later restarts',async t=>{
  const path=join(directory(t),'session.sqlite')
  const child=fork(fileURLToPath(new URL('./fixtures/session-child.mjs',import.meta.url)),[path],{silent:true})
  let childError=''
  child.stderr.on('data',chunk=>{childError+=chunk})
  t.after(()=>{if(child.exitCode===null)child.kill()})
  const [{base}]=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error(childError)}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('child startup timeout')),10000);timer.unref()})])
  const live=client(base)
  const events=await live.reply('测试半句恢复','audio')
  const {turn,audioId}=events[0]
  await live.post('/api/playback',{turn,audioId,event:'started'})
  const ack=await live.post('/api/playback',{turn,audioId,event:'progress',playedChars:4})
  assert.equal((await ack.json()).accepted,true)
  child.kill('SIGKILL');await once(child,'exit')
  let observed
  const next=await serve(t,path,{reply:async function*(request){observed=request;yield '收到。'}})
  const state=await next.status()
  assert.equal(state.sessionMemory.error,null)
  const previous=state.room.entries.find(entry=>entry.role==='assistant')
  assert.equal(previous.status,'cancelled')
  assert.equal(previous.interruptionReason,'runtime_restart')
  assert.equal(previous.text,'第一句。第二句。')
  assert.equal(previous.playedChars,4)
  assert.equal((await (await next.post('/api/playback',{turn,audioId,event:'ended',playedChars:8})).json()).accepted,false)
  const fresh=await next.reply('新声音','audio')
  assert.equal(fresh[0].turn,turn)
  assert.notEqual(fresh[0].audioId,audioId)
  assert.equal((await (await next.post('/api/playback',{turn,audioId,event:'started'})).json()).accepted,false)
  await next.post('/api/interrupt',{})
  await next.reply('接着说')
  assert.deepEqual(observed.history.map(entry=>entry.role),['user','assistant'])
  assert.equal(observed.history[1].content,'第一句。')
  assert.equal(JSON.stringify(observed.scene).includes('第二句'),false)
  assert.equal(observed.scene.find(entry=>entry.role==='assistant').deliveryState,'interrupted')
  await next.stop()
  const again=await serve(t,path)
  assert.equal((await again.status()).sessionMemory.turns,2)
})

test('unheard audio and imported display snapshots do not become delivered history',async t=>{
  const path=join(directory(t),'session.sqlite')
  const first=await serve(t,path,{roomSnapshot:{entries:[{id:1,role:'assistant',text:'旧气泡不能证明已送达',at:100,status:'completed'}]}})
  await first.reply('没播出去的句子','audio')
  await first.stop()
  let history
  const next=await serve(t,path,{reply:async function*(request){history=request.history;yield '收到'}})
  await next.reply('继续')
  assert.deepEqual(history,[])
  await next.stop()
  assert.throws(()=>createApp({sessionPath:path,roomSnapshot:{entries:[]}}),/already exists/)
})

test('clear resets durable and live memory, and stale windows cannot delete a new session',async t=>{
  const path=join(directory(t),'session.sqlite')
  const first=await serve(t,path)
  await first.reply('会被删除的对话')
  const before=await first.status()
  assert.equal((await first.post('/api/reset',{session:before.room.session})).status,200)
  assert.deepEqual((await first.status()).room.entries.map(entry=>entry.reason),['reset'])
  assert.equal((await first.post('/api/reset',{session:before.room.session})).status,409)
  await first.stop()
  let received
  const next=await serve(t,path,{reply:async function*(request){received=request;yield '新开始'}})
  assert.equal((await next.status()).sessionMemory.turns,0)
  await next.reply('新问题')
  assert.deepEqual(received.history,[])
  assert.equal(JSON.stringify(received.scene).includes('会被删除'),false)
  assert.equal(readFileSync(path).includes(Buffer.from('会被删除')),false)
})

test('each character card and mock engine keep separate delivered replies across restarts',async t=>{
  const path=join(directory(t),'session.sqlite')
  const card=id=>({stage:'desktop',owner:'test-window-01',capabilities:testCapabilities([],false,'model'),card:{id,name:id,prompt:`你是${id}`}})
  const seen=[]
  const reply=async function*(request){seen.push(request);yield request.profile.name+'的台词'}
  const first=await serve(t,path,{reply})
  await first.post('/api/runtime-profile',card('A'))
  await first.reply('给 A 的问题')
  await first.post('/api/runtime-profile',card('B'))
  await first.reply('给 B 的问题')
  assert.deepEqual(seen[1].history,[])
  assert.equal(seen[1].scene.some(entry=>entry.text==='A的台词'),false)
  await first.stop()
  const next=await serve(t,path,{reply})
  await next.post('/api/runtime-profile',card('A'))
  await next.reply('模拟对话','text','mock')
  await next.reply('记住什么')
  assert.equal(seen.at(-1).history.length,2)
  assert.equal(seen.at(-1).history[1].content,'A的台词')
})

test('history stays bounded while cumulative playback updates one turn',()=>{
  const memory=new SessionMemory()
  for(let index=0;index<20;index++) {
    const turn={deliveryId:String(index),characterId:'A',input:{source:'host',text:'问题',engine:'deepseek'},answer:'第一句。第二句。',delivery:'audio',generationDone:true,controller:new AbortController()}
    memory.remember(turn,'第一句。',1)
    memory.remember(turn,turn.answer,1)
  }
  assert.equal(memory.records.length,6)
  assert.equal(memory.history('A').length,12)
  assert.ok(memory.records.every(record=>record.complete))
})

test('completed audio remains complete after terminal cancellation releases the player',async t=>{
  const path=join(directory(t),'session.sqlite')
  const app=await serve(t,path)
  const [{turn,audioId}]=await app.reply('完整播出','audio')
  await app.post('/api/playback',{turn,audioId,event:'started'})
  await app.post('/api/playback',{turn,audioId,event:'ended',playedChars:8})
  assert.equal((await app.status()).room.entries.find(entry=>entry.role==='assistant').status,'completed')
  await app.stop()
  const store=new SessionStore(path)
  assert.equal(store.restored.memories.length,1)
  assert.equal(store.restored.memories[0].complete,true)
  assert.equal(store.restored.memories[0].interrupted,false)
  store.close()
})
