import assert from 'node:assert/strict'
import {once} from 'node:events'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'

// An isolated backend and browser use the real local whale model. No production settings or providers are touched.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const server=createApp({apiKey:'fixture',token:'',reply:async function*(){yield '语音和接话由独立链路处理。'}})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const context=await browser.newContext({viewport:{width:1500,height:1050},locale:'zh-CN'})
const errors=[],publications=[]
await context.addInitScript(()=>{
  localStorage.setItem('onboarding/completed','true')
  localStorage.setItem('cohost/enabled','true')
})
await context.route('http://127.0.0.1:8787/api/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/api/runtime-profile')publications.push(route.request().postDataJSON())
  if(path==='/api/status/events')return route.continue({url:base+path})
  await route.fulfill({response:await route.fetch({url:base+path})})
})
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
const post=async(path,body)=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json()}
const status=()=>fetch(base+'/api/status').then(r=>r.json())
const result={kind:'real browser and local whale model; synthetic commands; no model or speech provider calls',errors}
let frame
try {
  await page.goto(base)
  frame=await page.locator('#stage').elementHandle().then(h=>h.contentFrame())
  await frame.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressions.has('Param_Angle_Rotation_1_B_tail3'),null,{timeout:120000})
  await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').setLlmMode('all'))
  for(let n=0;n<100&&!publications.at(-1)?.capabilities.components.some(x=>x.name==='tailBase');n++)await page.waitForTimeout(100)

  result.capabilities=publications.at(-1)?.capabilities
  const params=['point','pointX','pointY','pointZ','danbaofan','ji','phone','phone2','phone3','shouji','phone7','maoshou','maoshou2','maoshou5','bi','pi','jingyu','fangzhuoshang','mozhua','mozhua2','baleite','chehui']
  const read=()=>frame.evaluate(ids=>{
    let element=document.querySelector('canvas');while(element&&!element.__vueParentComponent)element=element.parentElement
    let scene=element.__vueParentComponent;while(scene&&scene.type.__name!=='Live2D')scene=scene.parent
    const core=scene.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState.model.value.internalModel.coreModel
    return Object.fromEntries(ids.map(id=>[id,{value:core.getParameterValueById(id),min:core.getParameterMinimumValue(core.getParameterIndex(id)),max:core.getParameterMaximumValue(core.getParameterIndex(id))}]))
  },params)
  const exp=name=>({name,strength:1})
  const cases=[
    ['phone',{components:{phone:1,phoneOpen:1}}],
    ['phone-detail-only',{components:{phoneOpen:1}}],
    ['draw-component',{components:{draw:1}}],['draw-named',{expression:exp('画笔')}],
    ['erase-component',{components:{erase:1}}],['whale-head',{components:{whaleBuddy:1}}],
    ['whale-desk-only',{components:{whaleOnDesk:1}}],
    ['magic-claw',{expression:exp('魔爪')}],['parfait',{expression:exp('巴菲')}],
    ['draw-to-phone',{components:{draw:1}},{components:{phone:1}}],
    ['omelet-to-squeeze',{expression:exp('蛋包饭')},{expression:exp('挤')}],
    ['whale-to-desk',{expression:exp('鲸鱼')},{expression:exp('鲸鱼放桌上')}],
    ['claw-to-color',{expression:exp('魔爪')},{expression:exp('魔爪换色')}],
    ['drink-smile',{expression:exp('魔爪')},{expression:exp('smile')}],
    ['drink-component',{expression:exp('smile'),components:{beverage:1,beverageColor:1}}],
    ['dessert-show',{components:{dessertHide:0}}],
    ['toolbar-sequence',{components:{draw:1}},{expression:exp('橡皮')}],
    ['cat-paws',{components:{catPaws:1,catLeft:0.4,catRight:-0.3}}],
    ['peace',{components:{peace:1}}],
    ['mixed-prop-owners',{expression:exp('蛋包饭'),components:{beverage:0}},{expression:exp('魔爪'),components:{orderBoard:0}}],
    ['phone-color-flash',{components:{phone:1,phoneOpen:1,phoneColor:1,phoneFlash:0.5}}],
    ['order-press',{components:{orderBoard:1,orderX:0.2,orderY:-0.2,orderPress:1}}],
    ['undo-component',{components:{undo:1}}],
    ['dessert-hide',{components:{dessertHide:1}}],
  ]
  const expected={
    'phone':{phone:1,phone2:1,point:0},'phone-detail-only':{phone:0,phone2:1},
    'draw-component':{bi:1,point:1},'draw-named':{bi:1,point:1},'erase-component':{pi:1,point:1},
    'whale-head':{jingyu:1,fangzhuoshang:0},'whale-desk-only':{jingyu:0,fangzhuoshang:1},
    'magic-claw':{mozhua:1},'parfait':{baleite:1},'draw-to-phone':{bi:1,phone:1,point:0},
    'omelet-to-squeeze':{danbaofan:1,ji:1,point:0},'whale-to-desk':{jingyu:0,fangzhuoshang:1},
    'claw-to-color':{mozhua:1,mozhua2:1},'drink-smile':{mozhua:1},
    'drink-component':{mozhua:1,mozhua2:1},'dessert-show':{baleite:0},'toolbar-sequence':{bi:0,pi:1},
    'cat-paws':{maoshou:1,maoshou2:0.4,maoshou5:-0.3,point:0},'peace':{phone7:1,point:0},
    'mixed-prop-owners':{danbaofan:1,mozhua:1,point:0},
    'phone-color-flash':{phone:1,phone2:1,shouji:1,phone3:1.5,point:0},
    'order-press':{point:1,pointX:6,pointY:-6,pointZ:1},'undo-component':{chehui:1,bi:0,pi:0},
    'dessert-hide':{baleite:1},
  }
  result.cases=[]
  const baseline=await read()
  for(const [name,...frames] of cases){
    await post('performance',{name:'sequence',motion:{label:name,frames:frames.map(f=>({ms:200,holdMs:1000,pose:{},...f}))}})
    await page.waitForTimeout(frames.length===1?650:1700)
    const values=await read()
    for(const [id,value] of Object.entries(expected[name]))assert.ok(Math.abs(values[id].value-value)<0.01,name+': '+id)
    await page.locator('#stage').screenshot({path:'data/props-'+name+'.png'})
    result.cases.push({name,values})
    await post('performance',{name:'idle'})
    for(let n=0;n<30;n++){
      if(JSON.stringify(await read())===JSON.stringify(baseline))break
      await page.waitForTimeout(100)
    }
    assert.deepEqual(await read(),baseline,name+': restore')
  }
  assert.deepEqual(errors,[]);result.pass=true
  console.log(JSON.stringify(result.cases.map(c=>({name:c.name,values:Object.fromEntries(Object.entries(c.values).map(([k,v])=>[k,v.value]))}))))
}finally{writeFileSync('data/props-audit-'+(process.argv[2]||'before')+'.json',JSON.stringify(result,null,2));await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
