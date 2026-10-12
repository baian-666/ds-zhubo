import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
import {ParticipationError} from '../apps/cohost/participation-model.mjs'

// Isolated scene + simulated provider faults in the actual AIRI web renderer.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
let calls=0
const fixture=createApp({apiKey:'test-only',token:'',semanticEnabled:true,rehearsal:true,
 participationOptions:{debounceMs:1},airiOptions:{key:''},
 planner:async()=>{
  if(++calls===1)throw new ParticipationError('credentials')
  return {action:'reply_host',hostIntent:'invited',reason:'我来接住主播的问题。',text:'动作略过了，接话仍然正常。',
   performance:'smile',motion:{label:'坏动作',frames:[{ms:300,pose:{arbitrary:1}}]}}
 },reply:async function*(){throw Error('Prepared reply must not call another model')},
})
fixture.listen(0,'127.0.0.1');await once(fixture,'listening')
const base='http://127.0.0.1:'+fixture.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1380,height:900},locale:'zh-CN'})
const errors=[]
page.on('pageerror',error=>errors.push(error.message))
await page.addInitScript(()=>{localStorage.setItem('onboarding/completed','true');localStorage.setItem('settings/language','zh-Hans')})
await page.route('http://127.0.0.1:8787/api/**',async route=>{
 const response=await route.fetch({url:base+new URL(route.request().url()).pathname})
 await route.fulfill({response})
})
try {
 await page.goto('http://127.0.0.1:5173/?cohost')
 const panel=page.locator('[data-cohost-panel]')
 await panel.waitFor({timeout:60000})
 const send=async text=>{
  await panel.getByRole('textbox').fill(text)
  await panel.getByRole('button',{name:/^(发送|Send)$/,exact:true}).click()
 }
 await send('帮我总结一下。')
 await panel.getByText('模型服务拒绝了当前密钥，请检查本机配置。',{exact:true}).waitFor()
 await send('再帮我总结一次。')
 await panel.getByText('这次动作有一部分不合规，已略过；接话照常。',{exact:true}).waitFor()
 await panel.locator('[data-role="assistant"]').filter({hasText:'动作略过了，接话仍然正常。'}).waitFor()
 assert.equal(calls,2);assert.deepEqual(errors,[])
 const status=await fetch(base+'/api/status').then(response=>response.json())
 assert.equal(status.busy,false)
 assert.equal(status.room.entries.find(entry=>entry.reason==='participation_error').errorCode,'credentials')
 assert.equal(status.room.entries.at(-1).status,'completed')
 const result={kind:'mock faults + actual web panel',calls,errors,checks:['specific safe error visible','invalid action does not cancel speech','no second reply model call']}
 writeFileSync('data/reliability-browser-result.json',JSON.stringify(result,null,2))
 console.log(JSON.stringify(result))
} finally {
 await browser.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))
}
