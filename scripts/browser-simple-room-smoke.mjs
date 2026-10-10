import assert from 'node:assert/strict'
import {once} from 'node:events'
import {mkdirSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
let generations=0,plans=0
const server=createApp({apiKey:'test-only',token:'',rehearsal:true,semanticEnabled:true,
 reply:async function*(){generations++;yield '我来接一句（脚本模拟）。'},
 planner:async snapshot=>{plans++;const viewer=snapshot.eligibleViewers[0];return {action:viewer?'reply_viewer':'wait',hostIntent:'none',performance:'nod',reason:viewer?'主播说完了，我来回这条弹幕。':'我先听。',text:viewer?'收到这位观众的弹幕（脚本模拟）。':'',targetId:viewer?.id??'',platform:viewer?.platform??''}}
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1600,height:1040}})
page.setDefaultTimeout(15000)
const errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(()=>{if(location.origin==='http://127.0.0.1:5173'){localStorage.setItem('onboarding/completed','true');localStorage.setItem('onboarding/skipped','false')}})
try{
 await page.goto(base)
 await page.locator('#rehearsalState').filter({hasText:'自动决定'}).waitFor()
 assert.equal(await page.locator('#advancedControls').getAttribute('open'),null)
 assert.equal(await page.locator('#engine').isVisible(),false)
 await page.locator('#hostSubmit').click()
 await page.waitForFunction(()=>document.querySelector('.message.assistant .messageState')?.textContent.includes('回答完成'))
 assert.equal(generations,1)
 await page.locator('#speaking').check()
 await page.locator('#viewerTab').click()
 await page.locator('#preset').selectOption({index:2})
 assert.equal(await page.locator('#viewerText').inputValue(),'小鲸鱼能用一个例子解释一下吗？')
 await page.locator('#enqueue').click()
 await page.locator('.message.viewer').waitFor()
 await page.waitForTimeout(600)
 assert.equal(await page.locator('.message.assistant').count(),1,'continuous host speech holds viewer replies')
 await page.locator('#hostTab').click();await page.locator('#speaking').uncheck()
 await page.waitForFunction(()=>document.querySelectorAll('.message.assistant').length===2)
 assert.equal(plans,1)
 assert.equal(await page.locator('#advancedControls').getAttribute('open'),null,'normal rehearsal never opens advanced controls')
 const other=await browser.newPage()
 await other.addInitScript(()=>sessionStorage.setItem('rehearsalEngine','mock'))
 const writes=[];other.on('request',r=>{if(r.method()==='POST')writes.push(r.url())})
 await other.goto(base);await other.locator('#rehearsalState').filter({hasText:'模拟回复'}).waitFor()
 await other.waitForTimeout(850)
 assert.equal((await page.request.get(base+'/api/status').then(r=>r.json())).participation.enabled,true)
 assert.deepEqual(writes,[],'a background mock tab must not mutate the shared rehearsal merely by polling')
 await other.close()
 mkdirSync('data',{recursive:true})
 await page.screenshot({path:'data/simple-room-desktop.png',fullPage:true})
 await page.setViewportSize({width:390,height:844})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.locator('#hostSubmit').scrollIntoViewIfNeeded()
 await page.screenshot({path:'data/simple-room-mobile.png',fullPage:true})
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({passed:true,provider:'injected simulation',generations,plans,pageErrors:errors}))
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
