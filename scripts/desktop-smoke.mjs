import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {writeFileSync} from 'node:fs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser=await chromium.connectOverCDP('http://127.0.0.1:9250')
const stage=browser.contexts()[0].pages().find(page=>page.url().includes('synced-leader=true'))
assert.ok(stage,'The AIRI main stage must exist')
const motionModule='/@fs/'+fileURLToPath(new URL('../vendor/airi/packages/stage-ui-live2d/src/stores/motion-control.ts',import.meta.url)).replaceAll('\\','/')
const headers={'Content-Type':'application/json',...(process.env.COHOST_ACCESS_TOKEN?{Authorization:'Bearer '+process.env.COHOST_ACCESS_TOKEN}:{})}
const errors=[];stage.on('pageerror',e=>errors.push(e.message))
try {
 const status=await fetch('http://127.0.0.1:8787/api/status',{headers}).then(r=>r.json())
 assert.equal(status.busy,false,'Wait for the user conversation before a pose trial')
 const result=await fetch('http://127.0.0.1:8787/api/performance',{method:'POST',headers,body:JSON.stringify({name:'smile'})})
 assert.equal(result.status,200)
 await stage.evaluate(async path=>{ window.__cohostMotion = (await import(path)).useLive2DMotionControl() },motionModule)
 await stage.waitForFunction(()=>window.__cohostMotion.control.active && window.__cohostMotion.control.pose.mouthForm===0.8, null, {timeout:15000})
 const before = await stage.evaluate(()=>JSON.parse(JSON.stringify(window.__cohostMotion.control)))
 assert.equal(before.active,true)
 assert.equal(before.pose.mouthForm,0.8)
 await stage.waitForTimeout(450)
 await stage.screenshot({path:'data/desktop-stage-smile.png'})
 const pose=await stage.evaluate(async path=>{const {useLive2DMotionControl}=await import(path);return useLive2DMotionControl().control},motionModule)
 await stage.waitForFunction(()=>window.__cohostMotion.exclusiveOwnerId!=='ds-zhubo:performance',null,{timeout:8000})
 assert.equal(await stage.evaluate(()=>window.__cohostMotion.control.active),false)
 assert.equal(pose.active,true,'pose must still be active during the screenshot')
 assert.equal(pose.pose.mouthForm,0.8)
 assert.deepEqual(errors,[])
 const report={pass:true,url:stage.url(),canvas:await stage.locator('canvas').count(),pose,errors}
 writeFileSync('data/desktop-smoke-result.json',JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
} finally {await browser.close()}
