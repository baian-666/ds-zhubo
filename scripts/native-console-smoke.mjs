import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createApp } from '../apps/cohost/server.mjs'

// The real AIRI renderers share a fixture backend. No provider requests or microphone capture occur.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
let calls=0
const fixture=createApp({apiKey:'test-only',token:'',model:'test-cohost-model',voiceOptions:{},airiOptions:{key:''},
  planner:async()=>({action:'wait',reason:'先让主播讲完'}),
  reply:async function*({signal}) {
    calls++
    yield '试播收到，我在两个界面里是同一条回复。'
    if(calls===1) {
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
      yield '这句迟到的文字不能出现。'
    } else yield '小鲸鱼继续陪你聊。'
  },
})
fixture.listen(0,'127.0.0.1');await once(fixture,'listening')
const base='http://127.0.0.1:'+fixture.address().port
const desktop=await chromium.connectOverCDP('http://127.0.0.1:9250')
const stage=desktop.contexts()[0].pages().find(page=>page.url().includes('synced-leader=true'))
assert.ok(stage?.url().startsWith('http://localhost:5174/'),'desktop must preserve its origin and fixed independent port')
const web=await chromium.launch({channel:'msedge',headless:true})
const page=await web.newPage({viewport:{width:1380,height:900},locale:'zh-CN'})
const errors=[]
const result={kind:'fixture replies + actual desktop/web UI',calls:0,errors,checks:[]}
const handler=async route=>{
  const path=new URL(route.request().url()).pathname
  if(path.startsWith('/api/airi/stage/'))return route.continue()
  const response=await route.fetch({url:base+path})
  await route.fulfill({response})
}
const pages=[stage,page]
for(const target of pages){target.on('pageerror',error=>errors.push(error.message));await target.route('http://127.0.0.1:8787/api/**',handler)}
const status=()=>fetch(base+'/api/status').then(response=>response.json())
const panel=target=>target.locator('[data-cohost-panel]')
const button=(target,name)=>panel(target).getByRole('button',{name,exact:true})
try {
  await page.addInitScript(()=>localStorage.setItem('onboarding/completed','true'))
  await page.goto('http://127.0.0.1:5173/?cohost')
  for(const target of pages){
    console.log('Checking renderer:',new URL(target.url()).origin)
    await panel(target).waitFor({timeout:60000})
    await target.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressionGroups.size===44,null,{timeout:60000})
  }
  await button(stage,/^(主播|Host)$/).click()
  await panel(stage).getByRole('textbox').fill('小鲸鱼，你来回答。我们先验证两个窗口不会重复接话。')
  await button(stage,/^(发送|Send)$/).click()
  for(const target of pages)await panel(target).locator('[data-role="assistant"]').filter({hasText:'同一条回复'}).waitFor()
  assert.equal(calls,1)
  assert.equal((await status()).busy,true)
  result.checks.push('one reply shared by two native panels')
  await button(page,/^(停一下|Interrupt)$/).click()
  await panel(stage).getByText('已打断',{exact:true}).waitFor()
  assert.equal((await status()).busy,false)
  for(const target of pages)assert.equal(await panel(target).getByText('这句迟到的文字不能出现。').count(),0)
  result.checks.push('interrupt from other panel cancels old reply')
  await button(stage,/^(收起聊天|Collapse chat)$/).click()
  await button(stage,/^(直播间|Live room).*/).click()
  assert.equal(await panel(stage).getAttribute('data-open'),'true')
  result.checks.push('collapse and reopen without losing conversation')
  await button(page,/^(主播|Host)$/).click()
  await panel(page).getByRole('textbox').fill('主播未发送的草稿')
  await button(page,/^(观众|Viewer)$/).click()
  await panel(page).getByRole('textbox').fill('这个直播间真有意思，主播接着讲。')
  await button(page,/^(发送|Send)$/).click()
  await panel(stage).locator('[data-role="viewer"]').filter({hasText:'主播接着讲'}).waitFor()
  await button(page,/^(主播|Host)$/).click()
  assert.equal(await panel(page).getByRole('textbox').inputValue(),'主播未发送的草稿')
  result.checks.push('host/viewer drafts and shared simulated comment')
  for(const target of pages){
    await panel(target).getByText(/test-cohost-model/).waitFor()
    await button(target,/^(直播助播|Live cohost)$/).waitFor()
    assert.equal(await panel(target).getByRole('combobox').count(),0)
  }
  result.checks.push('effective settings visible with no director/engine selectors')
  await button(stage,/^(暂停回应|Pause replies)$/).click()
  await button(page,/^(恢复回应|Resume replies)$/).waitFor()
  await button(page,/^(恢复回应|Resume replies)$/).click()
  await button(stage,/^(暂停回应|Pause replies)$/).waitFor()
  result.checks.push('pause state synchronized')
  await stage.screenshot({path:'data/native-console-desktop-tested.png'})
  await page.screenshot({path:'data/native-console-web-tested.png'})
  await page.setViewportSize({width:390,height:780})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await button(page,/^(收起聊天|Collapse chat)$/).click()
  await button(page,/^(直播间|Live room).*/).click()
  await panel(page).getByRole('textbox').fill('小屏输入可用')
  await page.screenshot({path:'data/native-console-mobile-tested.png'})
  result.checks.push('390px fallback input and collapse reachable')
  result.calls=calls
  assert.equal(calls,1)
  assert.deepEqual(errors,[])
  writeFileSync('data/native-console-result.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify(result))
} finally {
  for(const target of pages)await target.unroute('http://127.0.0.1:8787/api/**',handler).catch(()=>{})
  await web.close()
  await desktop.close()
  fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))
}
