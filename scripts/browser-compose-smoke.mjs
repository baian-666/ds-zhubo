import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1400,height:1000}})
const errors=[],requests=[]
page.on('pageerror',error=>errors.push(error.message))
page.on('request',request=>requests.push(request.url()))
try {
 await page.goto('http://127.0.0.1:8790/')
 await page.waitForFunction(()=>window.preview?.ready,null,{timeout:45000})
 await page.evaluate(()=>{
  // Cubism restores saved parameters after computing vertices. Observe inputs at the actual geometry update.
  for(const model of Object.values(preview.models)) {
   const core=model.internalModel.coreModel,update=core.update.bind(core)
   core.update=()=>{
    model.observedPose=Object.fromEntries(['ParamMouthOpenY','ParamCheek76','ParamEyeLOpen','ParamBodyAngleZ'].map(id=>[id,core.getParameterValueById(id)]))
    return update()
   }
  }
 })
 for(const [action,time] of [['idle',0],['turn',Math.PI/2],['turn',Math.PI*1.5],['sway',Math.PI/2],['sway',Math.PI*1.5],['talk',.2],['smile',0]]) {
  await page.evaluate(({action,time})=>preview.setAction(action,time),{action,time})
  await page.waitForTimeout(250)
  await page.screenshot({path:`data/compose-preview/check-${action}-${time.toFixed(1)}.png`})
  const values=await page.evaluate(()=>{
   const {old,body,back}=preview.models
   return {mouth:old.observedPose.ParamMouthOpenY,
    smile:old.observedPose.ParamCheek76,
    eye:old.observedPose.ParamEyeLOpen,
    body:body.observedPose.ParamBodyAngleZ,
    aligned:old.x===back.x && old.y===back.y}
  })
  assert.equal(values.aligned,true)
  if(action==='smile'){assert.equal(values.smile,1);assert.equal(values.eye,0)}
  if(action==='talk')assert.ok(values.mouth>.3)
  if(action==='sway')assert.ok(Math.abs(values.body)>5)
 }
 await page.evaluate(()=>{
  const model=preview.models.old,core=model.internalModel.coreModel,get=core.getDrawableOpacity.bind(core)
  core.getDrawableOpacity=i=>{const opacity=get(i);(model.drawnOpacity??={})[core._model.drawables.ids[i]]=opacity;return opacity}
 })
 for(const mode of ['old','old-clean','body','compose']) {
  await page.locator('#mode').selectOption(mode)
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(()=>preview.models.old.visible),mode!=='body')
  assert.equal(await page.evaluate(()=>preview.models.body.visible),!['old','old-clean'].includes(mode))
  if(mode==='old-clean') {
   assert.equal(await page.evaluate(()=>[...preview.cleanHidden].every(id=>preview.models.old.drawnOpacity[id]===0)),true)
   assert.equal(await page.evaluate(()=>['ArtMesh110','ArtMesh111','ArtMesh112','ArtMesh201','ArtMesh60'].every(id=>preview.models.old.drawnOpacity[id]>.9)),true)
   await page.evaluate(()=>preview.setAction('idle',0));await page.waitForTimeout(100)
   await page.locator('canvas').screenshot({path:'data/compose-preview/old-clean-model.png'})
   await page.locator('#mode').selectOption('old');await page.waitForTimeout(100)
   assert.equal(await page.evaluate(()=>preview.models.old.drawnOpacity.ArtMesh108>.9 && preview.models.old.drawnOpacity.ArtMesh0>.9),true)
  }
 }
 await page.locator('#headScale').fill('0.9');await page.locator('#save').click()
 await page.reload();await page.waitForFunction(()=>window.preview?.ready)
 assert.equal(await page.locator('#headScale').inputValue(),'0.9')
 await page.locator('#reset').click();assert.equal(await page.locator('#headScale').inputValue(),'0.82')
 await page.setViewportSize({width:390,height:780})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 assert.ok(requests.every(url=>url.startsWith('http://127.0.0.1:8790/')))
 assert.deepEqual(errors,[])
 const result={kind:'actual dual-runtime-model composition in an isolated web preview',errors,checks:['front/back head alignment','left/right head and body motion rendered','mouth moves','smile suppresses normal eyes','four comparison modes','original props hidden while fingers, torso and tail remain','original props restored on mode switch','save and reload calibration','390px layout','no cohost or external requests']}
 writeFileSync('data/compose-preview/browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
} finally {await browser.close()}
