import {once} from 'node:events'
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {createApp} from '../apps/cohost/server.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const motionModule='/@fs/'+fileURLToPath(new URL('../vendor/airi/packages/stage-ui-live2d/src/stores/motion-control.ts',import.meta.url)).replaceAll('\\','/')
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1600,height:1040}});page.setDefaultTimeout(45000)
const errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(()=>{if(location.origin==='http://127.0.0.1:5173'){localStorage.setItem('onboarding/completed','true');localStorage.setItem('onboarding/skipped','false')}})
const real=process.argv.includes('--real')
if(real && !process.env.DEEPSEEK_API_KEY)throw new Error('真实试演需要本机 .env 密钥')
const server=createApp({apiKey:real ? process.env.DEEPSEEK_API_KEY : '',token:''});server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
try{
 await page.goto(base)
 await page.locator('#performanceState').filter({hasText:'角色已连接'}).waitFor({timeout:90000})
 if(real){
  await page.locator('#hostText').fill('小鲸鱼，蓝色大肥鱼这个名字挺适合你的，你怎么看？')
  await page.locator('#manualReply').click()
  await page.locator('.message.assistant .messageState').filter({hasText:'回答完成'}).waitFor()
  const reply=await page.request.get(base+'/api/status').then(r=>r.json())
  writeFileSync('data/performance-real-browser.json',JSON.stringify(reply.room.entries.filter(e=>e.role==='assistant'),null,2))
  assert.equal(reply.room.entries.filter(e=>e.role==='assistant').length,1)
  assert.ok(reply.room.entries.find(e=>e.role==='assistant').text)
  await page.waitForTimeout(300);await page.screenshot({path:'data/performance-real-browser.png',fullPage:true})
  await page.locator('#interrupt').click()
 }
 await page.locator('[data-pose=smile]').click()
 await page.locator('#performanceState').filter({hasText:'轻笑'}).waitFor()
 await page.waitForTimeout(800);await page.screenshot({path:'data/performance-smile.png',fullPage:true})
 const frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:5173/'))
 const pose=await frame.evaluate(async path=>{const {useLive2DMotionControl}=await import(path);return useLive2DMotionControl().control},motionModule)
 assert.equal(pose.pose.eyeSquint,0.55);assert.equal(pose.ownerId,'ds-zhubo:performance')
 await page.locator('#performanceState').filter({hasText:'待机'}).waitFor()
 await page.locator('[data-pose=pout]').click();await page.locator('#performanceState').filter({hasText:'嘴硬'}).waitFor()
 await page.waitForTimeout(500);await page.screenshot({path:'data/performance-pout.png',fullPage:true})
 await page.locator('#interrupt').click();await page.locator('#performanceState').filter({hasText:'待机'}).waitFor()
 await page.locator('[data-pose=nod]').click();await page.locator('#performanceState').filter({hasText:'点头'}).waitFor()
 await page.route('**/api/status',route=>route.abort());await page.waitForTimeout(2200)
 const released=await frame.evaluate(async path=>{const {useLive2DMotionControl}=await import(path);return useLive2DMotionControl().exclusiveOwnerId},motionModule)
 assert.notEqual(released,'ds-zhubo:performance')
 writeFileSync('data/performance-browser-result.json',JSON.stringify({pose,released,errors},null,2));console.log(JSON.stringify({pass:true,errors}))
}catch(e){await page.screenshot({path:'data/performance-failure.png',fullPage:true});console.log('PAGE:',await page.locator('#performanceState').textContent());console.log('ERRORS:',errors);throw e}
finally{await browser.close();server.close();server.closeAllConnections()}
