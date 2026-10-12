import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
import {biliPacket,decodeBiliPackets} from '../apps/cohost/bilibili.mjs'

// Isolated official-protocol fixtures drive the actual panels. No external platform or model calls occur.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
let socket,plans=0
class Socket extends EventTarget {
 constructor(){super();socket=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
 send(bytes){if(decodeBiliPackets(bytes)[0].operation===7)queueMicrotask(()=>this.emit(biliPacket(8,'{"code":0}')))}
 emit(bytes){this.dispatchEvent(new MessageEvent('message',{data:bytes}))}
 close(){this.dispatchEvent(new Event('close'))}
}
const fixture=createApp({apiKey:'fixture-only',token:'',semanticEnabled:true,rehearsal:true,airiOptions:{key:''},
 bilibiliOptions:{config:{accessKeyId:'fixture',accessKeySecret:'fixture-secret',appId:'123',code:'fixture-code'},WebSocketImpl:Socket,
  fetchImpl:async url=>Response.json({code:0,data:url.endsWith('/start')?{game_info:{game_id:'fixture'},anchor_info:{room_id:123},websocket_info:{wss_link:['wss://fixture.bilibili.com/sub'],auth_body:'fixture'}}:{}})},
 planner:async snapshot=>{plans++;const viewer=snapshot.eligibleViewers[0];return {action:'reply_viewer',reason:'这条猫咪弹幕接得上刚才的话题。',text:'跑步机成了猫咪的豪华卧室，运动的是你的钱包。',targetId:viewer.id,platform:viewer.platform}},
 reply:async function*(){throw Error('Prepared reply must not call a second model')},
})
fixture.listen(0,'127.0.0.1');await once(fixture,'listening')
const base=`http://127.0.0.1:${fixture.address().port}`
const desktop=await chromium.connectOverCDP('http://127.0.0.1:9250')
const stage=desktop.contexts()[0].pages().find(page=>page.url().includes('synced-leader=true'))
assert.ok(stage)
const web=await chromium.launch({channel:'msedge',headless:true})
const page=await web.newPage({viewport:{width:1380,height:900},locale:'zh-CN'})
const pages=[stage,page],errors=[],restore=new Map()
const panel=p=>p.locator('[data-cohost-panel]')
const handler=async route=>{
 const path=new URL(route.request().url()).pathname
 if(path.startsWith('/api/airi/stage/'))return route.continue()
 const response=await route.fetch({url:base+path});await route.fulfill({response})
}
for(const target of pages){target.on('pageerror',error=>errors.push(error.message));await target.route('http://127.0.0.1:8787/api/**',handler)}
try {
 await page.addInitScript(()=>localStorage.setItem('onboarding/completed','true'))
 await page.goto('http://127.0.0.1:5173/?cohost')
 for(const target of pages) {
  await panel(target).waitFor({timeout:60000})
  const wasOpen=await panel(target).getAttribute('data-open')==='true'
  const settingsOpen=await panel(target).locator('details').evaluate(e=>e.open)
  restore.set(target,{wasOpen,settingsOpen})
  if(!wasOpen)await panel(target).getByRole('button',{name:/^(直播间|Live room).*/}).click()
  if(!settingsOpen)await panel(target).locator('summary').click()
 }
 await panel(page).getByRole('button',{name:/^(连接 B站弹幕|Connect Bilibili chat)$/}).click()
 for(const target of pages)await panel(target).locator('[data-bilibili]').getByText(/(B站弹幕 · 已连接|Bilibili chat · Connected)/).waitFor()
 const event={cmd:'LIVE_OPEN_PLATFORM_DM',data:{msg_id:'fixture-message',room_id:123,open_id:'fixture-user',uname:'猫咪观众',msg:'我的跑步机被猫咪占领了',timestamp:Math.floor(Date.now()/1000)}}
 socket.emit(biliPacket(5,JSON.stringify(event)));socket.emit(biliPacket(5,JSON.stringify(event)))
 for(const target of pages) {
  await panel(target).locator('[data-role="assistant"]').filter({hasText:'运动的是你的钱包'}).waitFor()
  assert.equal(await panel(target).locator('[data-role="viewer"]').count(),1)
  await panel(target).getByText('猫咪观众',{exact:true}).waitFor()
  await panel(target).getByText(/^(B站观众|Bilibili viewer)$/).waitFor()
 }
 assert.equal(plans,1)
 await panel(stage).getByRole('button',{name:/^(断开 B站弹幕|Disconnect Bilibili chat)$/}).click()
 await panel(page).locator('[data-bilibili]').getByText(/(B站弹幕 · 未连接|Bilibili chat · Disconnected)/).waitFor()
 await page.screenshot({path:'data/bilibili-panel-web.png'})
 await stage.screenshot({path:'data/bilibili-panel-desktop.png'})
 await page.setViewportSize({width:390,height:780})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 assert.deepEqual(errors,[])
 const result={kind:'mock Bilibili protocol, actual desktop/web UI',plans,errors,checks:['connect and disconnect from either panel','fresh ordinary comment reaches planner','duplicate shown once','nickname and real source label','prepared reply uses one model call','390px layout']}
 writeFileSync('data/bilibili-browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
} finally {
 for(const target of pages) {
  const old=restore.get(target)
  if(old && !old.settingsOpen)await panel(target).locator('details').evaluate(e=>e.open=false).catch(()=>{})
  if(old && !old.wasOpen)await panel(target).getByRole('button',{name:/^(收起聊天|Collapse chat)$/}).click().catch(()=>{})
  await target.unroute('http://127.0.0.1:8787/api/**',handler).catch(()=>{})
 }
 await web.close();await desktop.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))
}
