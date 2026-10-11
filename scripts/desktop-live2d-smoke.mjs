import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser=await chromium.connectOverCDP('http://127.0.0.1:9250')
const stage=browser.contexts()[0].pages().find(p=>p.url().includes('synced-leader=true'))
const errors=[]
stage.on('pageerror',e=>errors.push(e.message))
const headers={'Content-Type':'application/json',...(process.env.COHOST_ACCESS_TOKEN?{Authorization:'Bearer '+process.env.COHOST_ACCESS_TOKEN}:{})}
const api=async(name,motion)=>{const r=await fetch('http://127.0.0.1:8787/api/performance',{method:'POST',headers,body:JSON.stringify({name,motion})});assert.equal(r.status,200)}
try {
 const status=await fetch('http://127.0.0.1:8787/api/status',{headers}).then(r=>r.json())
 assert.equal(status.busy,false);assert.equal(status.airi.active,false)
 await stage.reload()
 await stage.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressionGroups.size===44,null,{timeout:30000})
 await stage.screenshot({path:'data/whale-desktop-idle.png'})
 const results=[]
 for(const [name,id] of [['smile','ParamCheek76'],['think','ParamCheek74'],['surprise','ParamCheek75'],['pout','ParamCheek80']]){
  await api(name)
  await stage.waitForFunction(id=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').expressions.get(id).currentValue===1,id,{timeout:8000})
  await stage.waitForTimeout(400)
  const current=await stage.evaluate(id=>{
   let el=document.querySelector('canvas');while(el&&!el.__vueParentComponent)el=el.parentElement
   let c=el.__vueParentComponent;while(c&&c.type.__name!=='Live2D')c=c.parent
   const raw=c.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState
   const core=raw.model.value.internalModel.coreModel
   return {id,value:core.getParameterValueById(id),headY:core.getParameterValueById('ParamAngleY')}
  },id)
  assert.equal(current.value,1);results.push({name,...current})
  await stage.screenshot({path:'data/whale-desktop-'+name+'.png'})
 }
 await api('idle')
 await stage.waitForFunction(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').expressions.get('ParamCheek80').currentValue===0)
 if(process.argv.includes('--free-motion')){
  const motion={label:'桌面自由表演',frames:[{ms:1400,pose:{eyeX:-0.6,headZ:-0.3},expression:{name:'smile',strength:0.7}},{ms:1400,pose:{eyeX:0.5,headZ:0.3},expression:{name:'pout',strength:0.6}}]}
  await api('sequence',motion)
  await stage.waitForFunction(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-motion-control').control.active)
  const samples=[]
  for(let i=0;i<10;i++){
   samples.push(await stage.evaluate(()=>{
    const stores=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    const control=stores.get('live2d-motion-control').control
    let el=document.querySelector('canvas');while(el&&!el.__vueParentComponent)el=el.parentElement
    let c=el.__vueParentComponent;while(c&&c.type.__name!=='Live2D')c=c.parent
    const core=c.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState.model.value.internalModel.coreModel
    return {active:control.active,eyeX:core.getParameterValueById('ParamEyeBallX'),headZ:core.getParameterValueById('ParamAngleZ'),happy:core.getParameterValueById('ParamCheek76'),brow:core.getParameterValueById('ParamBrowLY')}
   }))
   if(i===3)await stage.screenshot({path:'data/free-motion-desktop.png'})
   await stage.waitForTimeout(180)
  }
  assert.ok(samples.some(x=>x.happy===1))
  assert.ok(samples.every(x=>x.happy===0||x.happy===1))
  assert.ok(samples.some(x=>x.brow<0&&x.brow>-0.56))
  assert.ok(Math.max(...samples.map(x=>x.headZ))-Math.min(...samples.map(x=>x.headZ))>0.1)
  await api('idle')
  await stage.waitForFunction(()=>!document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-motion-control').control.active)
  results.push({name:'sequence',samples})
 }
 assert.deepEqual(errors,[])
 writeFileSync('data/whale-desktop-result.json',JSON.stringify({pass:true,results,errors},null,2))
 console.log(JSON.stringify({pass:true,results,errors}))
} finally {await api('idle');await browser.close()}