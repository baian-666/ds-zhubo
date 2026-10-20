import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createApp } from '../apps/cohost/server.mjs'

// Real browser playback and route lifecycle, with local synthetic PCM and a fixture reply.
// No production provider, microphone, credential, or persisted user setting is changed.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const folder=mkdtempSync(join(tmpdir(),'cohost-media-browser-'))
const pcm=Buffer.alloc(22050*2*5)
for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(150*Math.sin(2*Math.PI*220*i/22050)),i*2)
let fixtureText='这是语音生命周期回归测试。',fixturePcm=pcm
let fixturePlan
const fixture=createApp({apiKey:'fixture',airiOptions:{key:'fixture-asr',fetchImpl:async()=>{throw Error('This test must not call ASR')}},token:'',
  semanticEnabled:true,planner:(...args)=>fixturePlan(...args),
  reply:async function*(){yield fixtureText},
  speechOptions:{engine:'index',fetchImpl:async url=>url.endsWith('/health')?Response.json({ok:true,engine:'index-2.5'}):new Response(
    JSON.stringify({type:'audio',pcm:fixturePcm.toString('base64'),sampleRate:22050})+'\n'+JSON.stringify({type:'done',firstPcmMs:1,totalMs:2})+'\n')},
})
fixture.listen(0,'127.0.0.1');await once(fixture,'listening')
const base='http://127.0.0.1:'+fixture.address().port
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']})
const context=await browser.newContext({viewport:{width:1380,height:900},locale:'zh-CN'})
const errors=[],requests=[]
await context.addInitScript(()=>{localStorage.setItem('onboarding/completed','true');localStorage.setItem('cohost/enabled','true');localStorage.setItem('cohost/use-airi-card','true')})
await context.route('http://127.0.0.1:8787/api/**',async route=>{
  const path=new URL(route.request().url()).pathname
  requests.push({path,method:route.request().method()})
  if(path==='/api/status/events')return route.continue({url:base+path})
  const response=await route.fetch({url:base+path})
  await route.fulfill({response})
})
const get=path=>fetch(base+'/api/'+path).then(r=>r.json())
const post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
async function until(read,accept,timeout=20000){
  const end=Date.now()+timeout
  while(Date.now()<end){const state=await read();if(accept(state))return state;await new Promise(r=>setTimeout(r,100))}
  throw Error('Timed out waiting for media state')
}
try {
  const page=await context.newPage()
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:5173/?cohost')
  await page.locator('[data-cohost-panel]').waitFor({timeout:120000})
  const status=await until(()=>get('status'),x=>x.airi.stages.some(s=>s.ready))
  const owner=status.airi.stages[0].owner
  assert.equal((await post('airi/start',{stage:'web',owner,capture:false})).status,200)
  await until(()=>get('status'),x=>x.airi.ready)
  await(await post('reply',{source:'host',text:'请读出测试句。',voiceOwner:owner})).text()
  await until(()=>get('status'),x=>x.room.entries.some(e=>e.timings?.playbackScheduledReceiptAt))
  const run=(await get('status')).airi.control
  // This actual router link unmounts the panel and Stage, leaving the application root alive.
  await page.locator('[data-cohost-panel]').getByRole('button',{name:/^(直播助播|Live cohost)$/}).click()
  await page.getByRole('link',{name:/^(调整声音与试听|Voice settings and preview)$/}).click()
  await page.locator('[data-cohost-speech]').waitFor()
  const after=await get('status')
  assert.equal(after.airi.control,run)
  assert.equal(after.airi.capture,false)
  assert.equal(await page.locator('[data-cohost-panel]').count(),0)
  await page.evaluate(async()=>{
    const cards=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('airi-card')
    await cards.updateCard(cards.activeCardId,{...structuredClone(JSON.parse(JSON.stringify(cards.activeCard))),name:'常驻同步测试',personality:'这是隔离测试的人格。'})
  })
  await until(()=>get('status'),x=>x.configuration.persona==='常驻同步测试')
  await until(()=>get('status'),x=>x.room.entries.some(e=>e.role==='assistant'&&e.status==='completed'))
  // Exact user-reported turns must survive both server authorization and played-text receipts.
  fixturePcm=pcm.subarray(0,8820)
  for(const text of [
    '行，做我自己——那我可得提前警告你，我这张嘴不太听劝。到时候弹幕先炸了你别怪我。',
    '做我自己——那不就等于放一条鱼进你的直播间里自由发挥吗。你自己想清楚。',
    '等等……真的？！好吧...那就这样！！',
  ]) {
    fixtureText=text
    await(await post('reply',{source:'host',text:'继续测试。',voiceOwner:owner})).text()
    const state=await until(()=>get('status'),x=>x.room.entries.some(e=>e.text===text&&['completed','failed','cancelled'].includes(e.status)))
    const answer=state.room.entries.findLast(e=>e.text===text)
    assert.equal(answer.status,'completed')
    assert.equal(answer.playedChars,text.length)
  }
  fixturePcm=pcm
  // A second browser window must not steal the renderer lease.
  const other=await context.newPage()
  await other.goto('http://127.0.0.1:5173/settings/modules/speech')
  await other.locator('[data-cohost-speech]').waitFor({timeout:120000})
  assert.equal((await get('status')).airi.control,run)
  // Permission failure or microphone cancellation must leave output alive.
  fixtureText='关麦之后，这条回答仍然播放到末尾。'
  await(await post('reply',{source:'host',text:'测试收音分离。',voiceOwner:owner})).text()
  await until(()=>get('status'),x=>x.room.entries.some(e=>e.text===fixtureText&&e.timings?.playbackScheduledReceiptAt))
  assert.equal((await post('airi/capture',{owner,capture:true})).status,200)
  await until(()=>get('status'),x=>x.airi.capture)
  assert.equal((await post('airi/capture',{owner,capture:false})).status,200)
  await until(()=>get('status'),x=>x.room.entries.some(e=>e.text===fixtureText&&e.status==='completed'))
  assert.equal((await get('status')).airi.control,run)
  assert.equal((await get('status')).configuration.persona,'常驻同步测试')
  await page.getByRole('button',{name:/^(试听当前声音|Preview current voice)$/}).click()
  await until(()=>get('status'),x=>x.room.entries.some(e=>e.source==='preview'&&e.timings?.playbackScheduledReceiptAt))
  await post('interrupt',{})
  await until(()=>get('speech/config'),x=>!x.preview)
  const diagnostic=await get('speech/diagnostics')
  assert.equal(diagnostic.turns.at(-1).status,'cancelled')
  // A committed first record must reach actual browser playback while the model is still waiting.
  fixturePcm=pcm.subarray(0,8820)
  let continueReply,closed=false,secondRequested=false
  const remaining=new Promise(resolve=>{continueReply=resolve})
  const first='首句现在已经完整了',second='这句等首句开始播放才生成。'
  fixturePlan=async()=>({action:'reply_host',hostIntent:'invited',reason:'这是首句边界回归。',text:first,targetId:'',platform:'',replyStream:{
    close(){closed=true;continueReply()},
    async *[Symbol.asyncIterator](){yield {kind:'speech',text:first};secondRequested=true;await remaining;if(!closed)yield {kind:'speech',text:second}},
  }})
  await post('director/event',{type:'mode',value:'auto'})
  for(const e of [{type:'speech-start'},{type:'transcript',text:'自然接话首声回归。',final:true},{type:'speech-end'}])await post('director/event',{...e,utterance:100})
  const firstPlayed=await until(()=>get('status'),x=>x.room.entries.some(e=>e.text===first&&e.timings?.playbackScheduledReceiptAt))
  assert.equal(secondRequested,true)
  assert.equal(firstPlayed.generating,true)
  assert.equal(closed,false)
  continueReply()
  const allPlayed=await until(()=>get('status'),x=>x.room.entries.some(e=>e.text===first+second&&e.status==='completed'))
  assert.equal(allPlayed.room.entries.findLast(e=>e.text===first+second).playedChars,(first+second).length)
  assert.equal(closed,true)
  assert.equal(requests.filter(r=>r.path.endsWith('/audio/transcriptions')).length,0)
  await page.screenshot({path:'data/media-lifecycle-web.png'})
  const relevant=errors.filter(message=>!/WebSocket|fetch|Failed to load.*model|NetworkError/i.test(message))
  assert.deepEqual(relevant,[])
  writeFileSync('data/media-lifecycle-result.json',JSON.stringify({kind:'actual browser + fixture LLM/PCM',checks:['text playback without capture','navigation preserves owner and audio completion','root persona sync after panel unmount','reported dash and repeated punctuation turns complete','second window cannot steal output or persona','capture toggle preserves playback','interrupt cancels preview','first committed record plays before remaining model generation'],diagnostic,errors},null,2))
  console.log('PASS: text playback, exact punctuation, route continuity, one renderer lease, preview interruption. Fixture audio, not a voice quality benchmark.')
}
finally {
  await browser.close()
  fixture.closeAllConnections();await new Promise(r=>fixture.close(r))
  assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep))
  rmSync(folder,{recursive:true,force:true})
}
