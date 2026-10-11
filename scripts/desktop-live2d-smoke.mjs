import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser=await chromium.connectOverCDP('http://127.0.0.1:9250')
const stage=browser.contexts()[0].pages().find(p=>p.url().includes('synced-leader=true'))
const errors=[]
stage.on('pageerror',e=>errors.push(e.message))
const headers={'Content-Type':'application/json',...(process.env.COHOST_ACCESS_TOKEN?{Authorization:'Bearer '+process.env.COHOST_ACCESS_TOKEN}:{})}
const api=async(name)=>{const r=await fetch('http://127.0.0.1:8787/api/performance',{method:'POST',headers,body:JSON.stringify({name})});assert.equal(r.status,200)}
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
 assert.deepEqual(errors,[])
 writeFileSync('data/whale-desktop-result.json',JSON.stringify({pass:true,results,errors},null,2))
 console.log(JSON.stringify({pass:true,results,errors}))
} finally {await api('idle');await browser.close()}