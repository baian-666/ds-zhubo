import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVoiceSetup, saveVoiceKey } from '../scripts/configure-voice.mjs'

function directory(t) {
  const path = mkdtempSync(join(tmpdir(),'cohost-voice-config-'))
  t.after(()=>rmSync(path,{recursive:true,force:true}))
  return path
}

test('voice configuration preserves other credentials and rejects multiline secrets', t => {
  const path = join(directory(t),'.env')
  writeFileSync(path,'# local\r\nDEEPSEEK_API_KEY=unchanged-test-value\r\nSILICONFLOW_API_KEY=old-test-value\r\nexport SILICONFLOW_API_KEY=duplicate-test-value\r\nPORT=8787\r\n')
  saveVoiceKey(path,'sk-test-voice-key-123456')
  const text=readFileSync(path,'utf8')
  assert.ok(text.includes('DEEPSEEK_API_KEY=unchanged-test-value\r\n'))
  assert.equal(text.match(/SILICONFLOW_API_KEY/g).length,1)
  assert.ok(text.endsWith('PORT=8787\r\n'))
  assert.throws(()=>saveVoiceKey(path,'valid-test-value\nOTHER=secret'))
  assert.equal(readFileSync(path,'utf8'),text)
})

async function start(t, fetchImpl) {
  const envPath=join(directory(t),'.env')
  const server=createVoiceSetup({envPath,fetchImpl})
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})
  const base='http://127.0.0.1:'+server.address().port
  const html=await (await fetch(base)).text()
  const nonce=html.match(/'X-Setup-Token':'([^']+)'/)[1]
  return {envPath,base,html,post:(key,override={})=>fetch(base+'/save',{method:'POST',
    headers:{'Content-Type':'application/json',Origin:base,'X-Setup-Token':nonce,...override},
    body:JSON.stringify({key})})}
}

test('voice setup protects local saves and never returns the credential', async t => {
  let calls=0
  const key='sk-test-local-123456789'
  const app=await start(t,async(url,options)=>{
    calls++
    assert.equal(url,'https://api.siliconflow.cn/v1/models')
    assert.equal(options.headers.Authorization,'Bearer '+key)
    return new Response('{}')
  })
  assert.ok(app.html.includes('type="password"'))
  assert.equal((await app.post(key,{Origin:'http://unrelated.example'})).status,403)
  assert.equal((await app.post(key,{'X-Setup-Token':'wrong'})).status,403)
  const badHostStatus=await new Promise((resolve,reject)=>{
    const req=request(app.base+'/save',{method:'POST',headers:{Host:'unrelated.example','Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode)})
    req.on('error',reject);req.end(JSON.stringify({key}))
  })
  assert.equal(badHostStatus,403)
  assert.equal(calls,0)
  const result=await app.post(key)
  assert.equal(result.status,200)
  assert.ok(!(await result.text()).includes(key))
  assert.equal(calls,1)
  assert.equal(readFileSync(app.envPath,'utf8'),'SILICONFLOW_API_KEY='+key+'\n')
})

test('provider errors cannot expose the submitted key or replace local configuration', async t => {
  const key='sk-test-error-123456789'
  const app=await start(t,async()=>{throw new Error('provider failure '+key)})
  const original='DEEPSEEK_API_KEY=unchanged-test-value\n'
  writeFileSync(app.envPath,original)
  const result=await app.post(key)
  assert.equal(result.status,502)
  assert.ok(!(await result.text()).includes(key))
  assert.equal(readFileSync(app.envPath,'utf8'),original)
})
