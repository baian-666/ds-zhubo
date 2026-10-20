import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve,sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { RuntimeSettings,speechSettings } from '../apps/cohost/runtime-settings.mjs'
import { SessionStore } from '../apps/cohost/session-store.mjs'
import { createApp } from '../apps/cohost/server.mjs'
import { speechProviders } from '../packages/cohost-contracts/speech.ts'

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'cohost-settings-')),path=join(dir,'session.sqlite'),stores=new Set(),servers=[]
  t.after(async()=>{
    for(const server of servers)if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
    for(const store of stores)store.close()
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})
  })
  const open=()=>{const store=new SessionStore(path);stores.add(store);return store}
  const close=store=>{store.close();stores.delete(store)}
  const start=async(options={})=>{
    const server=createApp({sessionPath:path,apiKey:'',token:'',speechOptions:{engine:'index',voice:'local-reference',fetchImpl:async()=>Response.json({ok:true,engine:'index-2.5'})},...options})
    servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening')
    const base=`http://127.0.0.1:${server.address().port}`
    return {server,get:async endpoint=>(await fetch(base+'/api/'+endpoint)).json(),
      post:(endpoint,body,signal)=>fetch(base+'/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal}),
      stop:()=>new Promise(resolve=>server.close(resolve))}
  }
  return {dir,path,open,close,start}
}

test('SQLite v1 upgrades once and ordinary settings survive restart without importing changed seeds',t=>{
  const f=fixture(t),legacy=new DatabaseSync(f.path)
  legacy.exec('CREATE TABLE current_session (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,saved_at INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE runtime_owner (id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL); PRAGMA user_version=1;')
  const old={format:1,room:{session:'old',version:1,entries:[{id:1,role:'host',text:'原聊天',at:1}]},scene:{topic:1,version:0,entries:[]},memories:[]}
  legacy.prepare('INSERT INTO current_session VALUES (1,1,1,?)').run(JSON.stringify(old));legacy.close()
  let store=f.open(),settings=new RuntimeSettings({store,seed:{engine:'index'}})
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,3)
  assert.equal(store.restored.room.entries[0].text,'原聊天')
  const initial=settings.snapshot();assert.equal(initial.speech.voice,'local-reference')
  settings.saveSpeech({engine:'siliconflow',voice:'bella'},initial.revision)
  const saved=settings.snapshot();f.close(store)
  store=f.open();settings=new RuntimeSettings({store,seed:{engine:'invalid-seed',voice:'invalid'}})
  assert.deepEqual(settings.snapshot(),saved)
  assert.equal(settings.status().storage,'sqlite')
  assert.equal(store.restored.room.entries[0].text,'原聊天')
})

test('a settings backup carries the same voice and revision and releases the runtime lease',async t=>{
  const f=fixture(t),store=f.open(),settings=new RuntimeSettings({store,seed:{engine:'qwen',voice:'Cherry'}})
  const backup=join(f.dir,'copy.sqlite');await store.backupTo(backup)
  const copy=new SessionStore(backup)
  try {assert.deepEqual(new RuntimeSettings({store:copy,seed:{engine:'index'}}).snapshot(),settings.snapshot())}
  finally {copy.close()}
})

test('ordinary configuration rejects secret fields, invalid provider voices and unknown versions',t=>{
  const f=fixture(t),store=f.open(),settings=new RuntimeSettings({store,seed:{engine:'index'}}),before=settings.snapshot()
  for(const input of [{engine:'index',voice:'claire'},{engine:'qwen',voice:'unknown'},{engine:'siliconflow',voice:'claire',apiKey:'PRIVATE-KEY'}])
    assert.throws(()=>settings.saveSpeech(input,before.revision),error=>error.status===400)
  assert.throws(()=>store.saveSettings({...before,secret:'PRIVATE-KEY'},before.revision))
  assert.equal(JSON.stringify(store.loadSettings()).includes('PRIVATE-KEY'),false)
  assert.deepEqual(settings.snapshot(),before)
  store.db.prepare('UPDATE runtime_settings SET payload=?').run(JSON.stringify({...before,schemaVersion:999}))
  assert.throws(()=>new RuntimeSettings({store,seed:{engine:'aqua'}}),/Saved runtime settings are invalid/)
  assert.equal(store.loadSettings().schemaVersion,999,'invalid saved data is never silently replaced by environment defaults')
})

test('stale repositories cannot overwrite a newer persisted revision',t=>{
  const f=fixture(t),store=f.open(),first=new RuntimeSettings({store,seed:{engine:'index'}})
  const stale=new RuntimeSettings({store,seed:{engine:'index'}}),before=stale.snapshot()
  const next=first.saveSpeech({engine:'qwen',voice:'Momo'},first.snapshot().revision)
  assert.throws(()=>stale.saveSpeech({engine:'aqua',voice:'local-reference'},before.revision),error=>error.status===409)
  assert.deepEqual(store.loadSettings(),next);assert.deepEqual(stale.snapshot(),before)
})

test('registry defaults match supported adapter voices, and a temporary runtime is explicit',()=>{
  for(const provider of speechProviders) {
    assert.deepEqual(speechSettings(provider.id),{engine:provider.id,voice:provider.voices[0]})
    for(const voice of provider.voices)assert.equal(speechSettings(provider.id,voice).voice,voice)
  }
  const settings=new RuntimeSettings({seed:{engine:'index'}})
  assert.deepEqual(settings.status(),{storage:'memory',savedAt:null})
  assert.equal(settings.saveSpeech({engine:'qwen',voice:'Vivian'},settings.snapshot().revision).speech.engine,'qwen')
})

test('native speech API saves persistently, preserves env bytes and survives clear and restart',async t=>{
  const f=fixture(t),envPath=join(f.dir,'.env'),env='DEEPSEEK_API_KEY=private-fixture\r\nCOHOST_TTS_PROVIDER=index\r\n'
  writeFileSync(envPath,env)
  let api=await f.start(),config=await api.get('speech/config')
  assert.equal(config.persistence.storage,'sqlite')
  const saved=await api.post('speech/config',{engine:'siliconflow',voice:'anna',revision:config.effective.revision})
  assert.equal(saved.status,200);const updated=await saved.json()
  const state=await api.get('status');assert.equal((await api.post('reset',{session:state.room.session})).status,200)
  assert.equal((await api.get('speech/config')).effective.revision,updated.revision)
  await api.stop();api=await f.start();config=await api.get('speech/config')
  assert.equal(config.effective.engine,'siliconflow');assert.equal(config.effective.voice,'anna')
  assert.equal(config.effective.revision,updated.revision)
  assert.equal(readFileSync(envPath,'utf8'),env)
  assert.equal((await api.post('speech/config',{engine:'index',revision:'old-window'})).status,409)
})

test('switching providers uses its own default voice, not the old environment seed',async t=>{
  const original=process.env.COHOST_TTS_VOICE
  process.env.COHOST_TTS_VOICE='local-reference'
  t.after(()=>{if(original===undefined)delete process.env.COHOST_TTS_VOICE;else process.env.COHOST_TTS_VOICE=original})
  const f=fixture(t),api=await f.start(),before=await api.get('speech/config')
  const response=await api.post('speech/config',{engine:'siliconflow',revision:before.effective.revision})
  assert.equal(response.status,200)
  assert.equal((await response.json()).voice,speechProviders.find(provider=>provider.id==='siliconflow').voices[0])
})

test('request cancellation after a slow validation cannot save the candidate voice',async t=>{
  const f=fixture(t);let finish
  const api=await f.start({speechOptions:{engine:'siliconflow',fetchImpl:()=>new Promise(resolve=>{finish=resolve})}})
  const before=await api.get('speech/config'),controller=new AbortController()
  const request=api.post('speech/config',{engine:'index',revision:before.effective.revision},controller.signal).catch(()=>null)
  while(!finish)await delay(2)
  controller.abort();await request;await delay(10)
  finish(Response.json({ok:true,engine:'index-2.5'}))
  for(let n=0;n<100;n++){if(!(await api.get('speech/config')).busy)break;await delay(2)}
  assert.deepEqual((await api.get('speech/config')).effective,before.effective)
  await api.stop();const store=f.open();assert.equal(store.loadSettings().revision,before.effective.revision)
})
