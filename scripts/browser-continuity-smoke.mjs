import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
let release,replyCalls=0,planCalls=0
const fixture=createApp({apiKey:'test-only',token:'',semanticEnabled:true,rehearsal:true,airiOptions:{key:''},
 participationOptions:{debounceMs:10},
 reply:async function*(){replyCalls++;yield '我正在接前一句话。';await new Promise(resolve=>{release=resolve});yield '前一句说完了。'},
 planner:async snapshot=>{
  planCalls++
  return {targetId:'',platform:'',performance:'idle',...(snapshot.pendingOpportunity?
   {action:'reply_followup',hostIntent:'spontaneous',thoughtId:snapshot.pendingThought.id,reason:'前一句已说完，现场仍然相关，我短短接回这个梗。',text:'跑步机的房东是年糕，你只是交电费的。'}:
   {action:'wait',hostIntent:'none',reason:'等当前回复说完，先不抢话。',text:'',thought:{text:'等说完再接回年糕占跑步机的房东梗。',wake:'after_reply'}})}
 },
})
fixture.listen(0,'127.0.0.1');await once(fixture,'listening')
const base='http://127.0.0.1:'+fixture.address().port
const desktop=await chromium.connectOverCDP('http://127.0.0.1:9250')
const stage=desktop.contexts()[0].pages().find(page=>page.url().includes('synced-leader=true'))
assert.ok(stage,'Desktop stage must be running')
const web=await chromium.launch({channel:'msedge',headless:true})
const page=await web.newPage({viewport:{width:1380,height:900},locale:'zh-CN'})
const errors=[],pages=[stage,page]
const previouslyOpen=new Map()
const handler=async route=>{
 const path=new URL(route.request().url()).pathname
 if(path.startsWith('/api/airi/stage/'))return route.continue()
 const response=await route.fetch({url:base+path});await route.fulfill({response})
}
for(const target of pages){target.on('pageerror',error=>errors.push(error.message));await target.route('http://127.0.0.1:8787/api/**',handler)}
const panel=target=>target.locator('[data-cohost-panel]')
const status=()=>fetch(base+'/api/status').then(r=>r.json())
const post=async(path,body)=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok);return response}
try {
 await page.addInitScript(()=>localStorage.setItem('onboarding/completed','true'))
 await page.goto('http://127.0.0.1:5173/?cohost')
 for(const target of pages){
  await panel(target).waitFor({timeout:60000})
  previouslyOpen.set(target,await panel(target).getAttribute('data-open'))
  if(previouslyOpen.get(target)==='false')await panel(target).getByRole('button',{name:/^(直播间|Live room).*/}).click()
 }
 await post('live/start',{})
 const send=async(target,text)=>{
  await panel(target).getByRole('button',{name:/^(主播|Host)$/,exact:true}).click()
  await panel(target).getByRole('textbox').fill(text)
  await panel(target).getByRole('button',{name:/^(发送|Send)$/,exact:true}).click()
 }
 await send(stage,'小鲸鱼，你觉得我买了跑步机却从来没跑，是不是有点离谱？猫叫年糕，它比我更喜欢这台机器。')
 await panel(page).locator('[data-role="assistant"]').filter({hasText:'正在接前一句话'}).waitFor()
 await send(page,'先别急着另开一条回复，我继续补一个笑点。年糕昨天睡在跑步机上，今天我只要走过去，它就盯着我，好像嫌我没有给它交房租。等你当前这句说完再接也行。')
 for(const target of pages)await panel(target).getByText('我先记着这个想法：等说完再接回年糕占跑步机的房东梗。',{exact:true}).waitFor()
 assert.equal(planCalls,1);assert.equal(replyCalls,1);assert.equal((await status()).busy,true)
 release()
 for(const target of pages)await panel(target).locator('[data-role="assistant"]').filter({hasText:'你只是交电费的'}).waitFor({timeout:10000})
 assert.equal(planCalls,2);assert.equal(replyCalls,1)
 const state=await status();assert.equal(state.participation.pendingThought,null);assert.equal(state.busy,false)
 await page.waitForTimeout(1500);assert.equal(planCalls,2,'must not repeat quiet reviews')
 assert.deepEqual(errors,[])
 const result={kind:'mock continuity + actual native desktop/web panels',planCalls,replyCalls,errors,
  checks:['both panels show deferred public intention','old reply survives the new host utterance','one quiet recheck after delivery','prepared follow-up needs no second generator','no duplicate continuation']}
 writeFileSync('data/continuity-browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
} finally {
 release?.()
 for(const target of pages)if(previouslyOpen.get(target)==='false' && await panel(target).getAttribute('data-open').catch(()=>null)==='true')
  await panel(target).getByRole('button',{name:/^(收起聊天|Collapse chat)$/}).click().catch(()=>{})
 for(const target of pages)await target.unroute('http://127.0.0.1:8787/api/**',handler).catch(()=>{})
 await web.close();await desktop.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))
}
