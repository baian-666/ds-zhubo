import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createApp} from '../apps/cohost/server.mjs'
import {ModuleSettings} from '../apps/cohost/module-settings.mjs'
import {CharacterCatalog} from '../apps/cohost/character-catalog.mjs'
import {SessionStore} from '../apps/cohost/session-store.mjs'
import {RuntimeProfile} from '../apps/cohost/runtime-profile.mjs'
import {testCapabilities} from './fixtures/performance.mjs'

const card=(name='鲸鱼',personality='保持幽默')=>({name,version:'1',personality,extensions:{custom:{keep:['unknown',1]},airi:{modules:{consciousness:{provider:'',model:''},speech:{provider:'',model:'',voice_id:''},vision:{provider:'',model:''}},agents:{}}}})
const catalog=()=>({activeId:'whale',bound:true,cards:[{id:'default',data:card('默认')},{id:'whale',data:card()}]})
async function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'cohost-modules-')),path=join(dir,'session.sqlite');let server
  const start=async()=>{server=createApp({sessionPath:path,apiKey:'fixture',token:'',speechOptions:{engine:'index'},serviceOptions:{fetchImpl:async()=>Response.json({data:[{id:'new-model'}]})},...options});server.listen(0,'127.0.0.1');await once(server,'listening')}
  await start()
  const get=async name=>(await fetch(`http://127.0.0.1:${server.address().port}/api/${name}`)).json()
  const post=(name,body,signal)=>fetch(`http://127.0.0.1:${server.address().port}/api/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal})
  const stop=()=>new Promise(resolve=>server.close(resolve))
  t.after(async()=>{if(server.listening){server.closeAllConnections();await stop()}assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})})
  return {get,post,path,restart:async()=>{await stop();await start()}}
}

test('model configuration persists independently of speech and reaches the live reply',async t=>{
  let used
  const api=await fixture(t,{reply:async function*(options){used=options;yield '你好。'}})
  const old=await api.get('services/config'),voice=await api.get('speech/config')
  const saved=await api.post('services/config',{module:'inference',revision:old.inference.revision,value:{provider:'deepseek',model:'new-model'}})
  assert.equal(saved.status,200)
  assert.equal((await api.get('speech/config')).effective.revision,voice.effective.revision)
  await api.restart()
  assert.equal((await api.get('services/config')).inference.value.model,'new-model')
  await (await api.post('reply',{source:'host',text:'你听见了吗',delivery:'text'})).text()
  assert.equal(used.model,'new-model')
  assert.equal((await api.get('services/config')).recognition.revision,old.recognition.revision)
  assert.equal((await api.post('services/config',{module:'inference',revision:old.inference.revision,value:{provider:'deepseek',model:'new-model'}})).status,409)
})

test('model validation, storage failure and stale writes keep effective settings',async t=>{
  const api=await fixture(t),old=await api.get('services/config')
  const body={module:'inference',revision:old.inference.revision,value:{provider:'deepseek',model:'missing'}}
  assert.equal((await api.post('services/config',body)).status,400)
  body.value.model='new-model'
  const db=new DatabaseSync(api.path);db.exec("CREATE TRIGGER fail_modules BEFORE UPDATE ON module_settings BEGIN SELECT RAISE(ABORT,'fixture');END;");db.close()
  assert.equal((await api.post('services/config',body)).status,503)
  assert.deepEqual((await api.get('services/config')).inference,old.inference)
})

test('a cancelled model validation cannot commit a late result',async t=>{
  let finish
  const api=await fixture(t,{serviceOptions:{fetchImpl:()=>new Promise(resolve=>{finish=resolve})}}),before=await api.get('services/config'),controller=new AbortController()
  const pending=api.post('services/config',{module:'inference',revision:before.inference.revision,value:{provider:'deepseek',model:'new-model'}},controller.signal).catch(()=>null)
  for(let i=0;i<100&&!finish;i++)await new Promise(resolve=>setTimeout(resolve,2))
  assert.ok(finish);controller.abort();await pending;await new Promise(resolve=>setTimeout(resolve,10))
  finish(Response.json({data:[{id:'new-model'}]}));await new Promise(resolve=>setTimeout(resolve,10))
  assert.deepEqual((await api.get('services/config')).inference,before.inference)
})

test('recognition rejects unsupported adapters and credential fields',async t=>{
  const api=await fixture(t),before=await api.get('services/config')
  for(const value of [{provider:'unwired',model:'unknown'},{...before.recognition.value,apiKey:'PRIVATE'}])
    assert.equal((await api.post('services/config',{module:'recognition',revision:before.recognition.revision,value})).status,400)
  assert.deepEqual((await api.get('services/config')).recognition,before.recognition)
})

test('local recognition is verified before persistence and can switch back without changing speech',async t=>{
  let available=true,fail=false,prepared=0,cleared=0
  const adapter={available:()=>available,async prepare(){prepared++;if(fail)throw Error('model missing')},clear(){cleared++}}
  const api=await fixture(t,{airiOptions:{key:'fixture',localRecognitionAdapter:adapter}})
  const before=await api.get('services/config'),speech=await api.get('speech/config')
  const value={provider:'local',model:'sherpa-zipformer-zh'}
  available=false
  assert.equal((await api.post('services/config',{module:'recognition',revision:before.recognition.revision,value})).status,503)
  available=true;fail=true
  assert.notEqual((await api.post('services/config',{module:'recognition',revision:before.recognition.revision,value})).status,200)
  assert.deepEqual((await api.get('services/config')).recognition,before.recognition)
  fail=false
  assert.equal((await api.post('services/config',{module:'recognition',revision:before.recognition.revision,value})).status,200)
  assert.equal(prepared,2);assert.equal(cleared,2,'verification must release the local worker')
  await api.restart()
  const current=await api.get('services/config')
  assert.deepEqual(current.recognition.value,value)
  assert.equal((await api.post('services/config',{module:'recognition',revision:current.recognition.revision,value:before.recognition.value})).status,200)
  assert.deepEqual((await api.get('speech/config')).effective,speech.effective)
})

test('character catalog survives restart and reset with unknown fields and active identity preserved',async t=>{
  const api=await fixture(t),value=catalog()
  assert.equal((await api.post('characters',{revision:null,value})).status,200)
  const saved=await api.get('characters')
  assert.deepEqual(saved.catalog.value,value)
  assert.equal((await api.get('status')).configuration.persona,'鲸鱼')
  assert.equal((await api.post('characters',{revision:null,value})).status,409)
  const status=await api.get('status');assert.equal((await api.post('reset',{session:status.room.session})).status,200)
  await api.restart()
  assert.deepEqual((await api.get('characters')).catalog,saved.catalog)
  assert.equal((await api.get('status')).configuration.cardId,'whale')
})

test('character catalog rejects missing selection, secret fields, duplicates and disk failures',async t=>{
  const api=await fixture(t)
  for(const value of [{...catalog(),activeId:'absent'},{...catalog(),cards:[...catalog().cards,...catalog().cards]},
    {...catalog(),cards:[{id:'default',data:{...card(),apiKey:'PRIVATE'}},{id:'whale',data:card()}]}])
    assert.equal((await api.post('characters',{revision:null,value})).status,400)
  await api.post('characters',{revision:null,value:catalog()});const old=await api.get('characters')
  const db=new DatabaseSync(api.path);db.exec("CREATE TRIGGER fail_cards BEFORE UPDATE ON module_settings WHEN old.id='characters' BEGIN SELECT RAISE(ABORT,'fixture');END;");db.close()
  assert.equal((await api.post('characters',{revision:old.catalog.revision,value:{...catalog(),bound:false}})).status,503)
  assert.deepEqual((await api.get('characters')).catalog,old.catalog)
})

test('service and character repositories reject unsupported saved formats without reseeding',async t=>{
  const api=await fixture(t)
  const db=new DatabaseSync(api.path)
  const row=db.prepare("SELECT payload FROM module_settings WHERE id='inference'").get()
  const value=JSON.parse(row.payload);value.schemaVersion=99
  db.prepare("UPDATE module_settings SET payload=? WHERE id='inference'").run(JSON.stringify(value));db.close()
  await assert.rejects(api.restart(),/Saved service configuration is invalid/)
})

test('independent repository instances cannot overwrite newer commits',()=>{
  const rows=new Map(),store={loadModule:key=>rows.get(key),saveModule:(key,value,revision)=>{if((rows.get(key)?.revision??null)!==revision)throw Object.assign(Error(),{code:'SETTINGS_CONFLICT'});rows.set(key,structuredClone(value))}}
  const first=new ModuleSettings({store}),stale=new ModuleSettings({store})
  first.save('inference',{provider:'deepseek',model:'new'},first.snapshot('inference').revision)
  assert.throws(()=>stale.save('inference',{provider:'deepseek',model:'stale'},stale.snapshot('inference').revision),error=>error.status===409)
  const cards=new CharacterCatalog(store),oldCards=new CharacterCatalog(store)
  cards.save(catalog(),null)
  assert.throws(()=>oldCards.save(catalog(),null),error=>error.status===409)
})

test('persisted identity survives stage loss and stale renderer metadata cannot replace it',()=>{
  const saved=new CharacterCatalog();saved.save(catalog(),null)
  let now=0
  const profiles=new RuntimeProfile({catalog:saved,now:()=>now,owner:()=>null})
  profiles.update({stage:'web',owner:'browser-owner',card:{id:'stale',name:'旧窗口',prompt:'旧人设'},capabilities:testCapabilities()})
  assert.equal(profiles.snapshot().cardId,'whale');assert.equal(profiles.snapshot().prompt,'保持幽默')
  now=40000
  assert.equal(profiles.snapshot().name,'鲸鱼');assert.deepEqual(profiles.snapshot().capabilities.expressions,[])
  assert.deepEqual(saved.snapshot().value.cards[1].data.extensions.custom,{keep:['unknown',1]})
})
