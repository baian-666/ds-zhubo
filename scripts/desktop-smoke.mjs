import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

// Runs against the user's desktop without changing settings or starting the microphone.
// --voice also sends one short, real paid-model request and tests a local voice preview interruption.
const root=fileURLToPath(new URL('../',import.meta.url))
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const local=parseEnv(readFileSync(join(root,'.env'),'utf8'))
const headers=local.COHOST_ACCESS_TOKEN?{Authorization:'Bearer '+local.COHOST_ACCESS_TOKEN}:{}
const status=()=>fetch('http://127.0.0.1:8787/api/status',{headers}).then(r=>r.json())
const api=async(path,body)=>{
  const response=await fetch('http://127.0.0.1:8787/api/'+path,{method:body?'POST':'GET',headers:{...headers,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
  assert.equal(response.ok,true,'API request failed: '+path)
  return response.json()
}
const health=()=>fetch('http://127.0.0.1:5174/__cohost_desktop').then(r=>r.json())
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
function launch() {
  const child=spawn('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',join(root,'scripts/start-desktop.ps1')],{cwd:root,windowsHide:true,stdio:'ignore'})
  child.unref()
  return child
}
async function until(read,accept,timeout=60000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline){const value=await read();if(accept(value))return value;await sleep(200)}
  throw Error('Desktop smoke check timed out')
}
const result={errors:[]},start=performance.now()
let browser,settings,createdSettings=false
try {
  launch()
  browser=await until(()=>chromium.connectOverCDP('http://127.0.0.1:9250',{timeout:800}).catch(()=>null),Boolean)
  result.cdpMs=Math.round(performance.now()-start)
  const context=browser.contexts()[0]
  const page=await until(async()=>context.pages().find(p=>p.url().includes('synced-leader=true')),Boolean)
  page.on('pageerror',e=>result.errors.push(e.message))
  const devRequests=[]
  page.on('request',r=>{if(/\/@vite\/|\/src\/renderer\//.test(r.url()))devRequests.push(r.url())})
  await page.bringToFront()
  if(await page.getByRole('button',{name:'直播间',exact:true}).isVisible())await page.getByRole('button',{name:'直播间',exact:true}).click()
  const panel=page.locator('[data-cohost-panel]')
  await panel.waitFor({timeout:60000})
  result.panelMs=Math.round(performance.now()-start)
  result.model=await page.evaluate(()=>localStorage.getItem('settings/stage/model'))
  assert.ok(result.model?.startsWith('display-model-'),'Saved display model missing')
  await page.waitForFunction(()=>!!document.querySelector('canvas'),null,{timeout:60000})
  result.canvasMs=Math.round(performance.now()-start)
  const serving=await health()
  assert.equal(serving.build,JSON.parse(readFileSync(join(root,'data/desktop-build.json'),'utf8')).active)
  result.build=serving.build
  await page.screenshot({path:join(root,'data/desktop-fixed-stage.png')})

  const existing=new Set(context.pages()),settingsStart=performance.now()
  await panel.getByRole('button',{name:'直播助播',exact:true}).click()
  settings=await until(async()=>context.pages().find(p=>p!==page&&p.url().includes('#/settings')),Boolean,15000)
  createdSettings=!existing.has(settings)
  settings.on('pageerror',e=>result.errors.push(e.message))
  const directorSettings=settings.locator('[data-director-settings]')
  await directorSettings.waitFor()
  await directorSettings.getByRole('button',{name:/^(添加反馈|Add feedback)$/}).waitFor()
  result.directorSettings=await directorSettings.innerText()
  assert.ok(result.directorSettings.includes('MCP'),'Native director settings must expose MCP status')
  assert.equal(await settings.locator('iframe[src*="director-handbook"]').count(),0,'Handbook must render inside native settings')
  await directorSettings.scrollIntoViewIfNeeded()
  await settings.screenshot({path:join(root,'data/director-handbook-native.png')})
  await settings.getByRole('link',{name:/^(调整声音与试听|Voice settings and preview)$/}).click()
  await settings.locator('[data-cohost-speech] [data-effective-speech]').waitFor()
  result.settingsMs=Math.round(performance.now()-settingsStart)
  result.speechSetting=await settings.locator('[data-effective-speech]').innerText()
  const currentSpeech=await api('speech/config')
  assert.ok(result.speechSetting.includes(currentSpeech.effective.model),'Native speech settings differ from the active backend')
  assert.ok(page.url().endsWith('#/'),'Settings replaced the main stage')
  await settings.screenshot({path:join(root,'data/desktop-fixed-settings.png')})

  if(process.argv.includes('--voice')) {
    const before=await status(),known=new Set(before.room.entries.map(e=>e.id))
    assert.equal(before.airi.capture,false,'Do not interrupt a live microphone test')
    await page.bringToFront()
    await panel.getByRole('textbox').fill('小鲸鱼，固定版启动好了，请简单说一句你好，十个字以内。')
    const voiceStart=Date.now()
    await panel.getByRole('button',{name:'发送',exact:true}).click()
    const after=await until(status,s=>s.room.entries.some(e=>!known.has(e.id)&&e.role==='assistant'&&['completed','failed','cancelled'].includes(e.status)),90000)
    const answer=after.room.entries.findLast(e=>!known.has(e.id)&&e.role==='assistant')
    assert.equal(answer.status,'completed')
    assert.equal(answer.playedChars,answer.text.length)
    assert.equal(after.airi.capture,false)
    result.voice={elapsedMs:Date.now()-voiceStart,playedChars:answer.playedChars,status:answer.status,timings:answer.timings,capture:false}

    // A preview uses the same real output queue and can be cancelled from the main window.
    const config=await api('speech/config')
    await api('speech/preview',{revision:config.effective.revision})
    await until(()=>api('speech/config'),s=>s.preview,15000)
    await panel.getByRole('button',{name:'停一下',exact:true}).click()
    await until(()=>api('speech/config'),s=>!s.preview&&!s.busy,15000)
    result.previewInterrupted=true
  }

  if(createdSettings){await settings.close();createdSettings=false}
  launch();await sleep(3000)
  assert.equal((await health()).pid,serving.pid,'Repeated launch created another runtime')
  result.repeatLaunchReused=true
  result.devRequests=devRequests.length
  assert.equal(result.devRequests,0)
  assert.deepEqual(result.errors,[])
  result.capture=(await status()).airi.capture
  await page.bringToFront()
} finally {
  if(createdSettings)await settings.close().catch(()=>{})
  await browser?.close()
  writeFileSync(join(root,'data/desktop-fixed-smoke.json'),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
}
