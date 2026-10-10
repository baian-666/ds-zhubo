import assert from 'node:assert/strict'
import {once} from 'node:events'
import {mkdirSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
import {planParticipation} from '../apps/cohost/participation-model.mjs'
import {streamReply} from '../apps/cohost/deepseek.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const real=process.argv.includes('--real')
const screenshot=real ? 'data/participation-real-desktop.png' : 'data/participation-mock-desktop.png'
if(real && !process.env.DEEPSEEK_API_KEY)throw new Error('真实试验需要本机 .env 密钥')
let plans=0,generations=0
const server=createApp({apiKey:real ? process.env.DEEPSEEK_API_KEY : 'test-only',token:'',semanticEnabled:true,
 planner:async(snapshot,options)=>{plans++;return real ? planParticipation(snapshot,{...options,apiKey:process.env.DEEPSEEK_API_KEY,model:process.env.DEEPSEEK_MODEL || 'deepseek-flash'}) : {action:snapshot.latestHost.text.includes('先听')?'wait':'reply_host',hostIntent:'invited',reason:'我先听完，遇到提问再接话。',text:snapshot.latestHost.text.includes('先听')?'':'年糕的晾衣机可真豪华。',targetId:'',platform:''}},
 reply:async function*(options){generations++;if(real)yield*streamReply(options);else yield '猫叫年糕。'}
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1600,height:1050}})
page.setDefaultTimeout(15000)
const errors=[];page.on('pageerror',error=>errors.push(error.message))
await page.addInitScript(()=>{if(location.origin==='http://127.0.0.1:5173'){localStorage.setItem('onboarding/completed','true');localStorage.setItem('onboarding/skipped','false')}})
try{
 await page.goto('http://127.0.0.1:'+server.address().port)
 await page.waitForFunction(()=>document.getElementById('initiative').checked)
 await page.locator('#advancedControls > summary').click()
 await page.locator('#mode').selectOption('auto')
 await page.locator('#scenario').selectOption('setup');await page.locator('#hostSubmit').click()
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message.director .messageState')).some(x=>x.textContent.includes('自主判断')))
 assert.equal(await page.locator('.message.assistant').count(),0,'explicit request to finish story must wait')
 await page.locator('#scenario').selectOption('natural');await page.locator('#hostSubmit').click()
 await page.waitForFunction(()=>document.querySelector('.message.assistant .messageState')?.textContent.includes('回答完成'))
 assert.ok((await page.locator('.message.assistant .messageState').textContent()).includes('判断与拟稿'))
 assert.equal(generations,0,'prepared response must not call generation again')
 await page.locator('#scenario').selectOption('recall');await page.locator('#hostSubmit').click()
 await page.waitForFunction(()=>document.querySelectorAll('.message.assistant .messageState').length===2 && Array.from(document.querySelectorAll('.message.assistant .messageState')).every(x=>x.textContent.includes('回答完成')))
 assert.ok((await page.locator('.message.assistant .bubble').last().textContent()).includes('年糕'))
 assert.equal(plans,2);assert.equal(generations,1);assert.deepEqual(errors,[])
 const timing=await page.locator('.message.assistant .messageState').allTextContents()
 mkdirSync('data',{recursive:true});await page.locator('#latest').click();await page.screenshot({path:screenshot,fullPage:true})
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.waitForFunction(()=>!document.getElementById('status').textContent.includes('助播回答中') && !document.getElementById('manualReply').disabled)
 await page.locator('#engine').selectOption('mock');await page.waitForFunction(()=>!document.getElementById('initiative').checked)
 assert.equal(await page.locator('#initiative').isDisabled(),true)
 console.log(JSON.stringify({passed:true,real,plans,generations,timing,screenshot}))
}catch(error){console.log(JSON.stringify({plans,generations,errors,bubbles:await page.locator('.bubble').allTextContents(),feedback:await page.locator('#testFeedback').textContent(),state:await page.locator('#initiativeState').textContent()}));throw error}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
