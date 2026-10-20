import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'

// Observe the shipped Cubism mesh boundary. No commands, settings or speech are sent.
const {chromium}=await import('../vendor/airi/node_modules/playwright/index.mjs')
const baseline=process.argv.includes('--baseline')
const directory=`data/tail-idle-desktop-${baseline?'before':'after'}-${Date.now()}`
mkdirSync(directory)
const browser=await chromium.connectOverCDP('http://127.0.0.1:9250')
const page=browser.contexts()[0].pages().find(page=>page.url().includes('synced-leader=true'))
const result={kind:'Unprompted idle movement in the real fixed Electron desktop',baseline,errors:[]}
try{
  assert.ok(page)
  page.on('pageerror',error=>result.errors.push(error.message))
  await page.waitForFunction(()=>!!document.querySelector('canvas')&&!!globalThis.Live2DCubismCore?.Model&&document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressions.has('Param_Angle_Rotation_1_B_tail3'),null,{timeout:60000})
  await page.bringToFront()
  result.setup=await page.evaluate(()=>{
    const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions')
    const ids=['1','2','3'].map(index=>`Param_Angle_Rotation_${index}_B_tail3`)
    const prototype=globalThis.Live2DCubismCore.Model.prototype
    const original=prototype.update
    const samples=[]
    const snapshot=()=>JSON.stringify(ids.map(id=>store.expressions.get(id)))
    const saved=snapshot()
    const wrapped=function(...args){
      const indices=ids.map(id=>this.parameters.ids.indexOf(id))
      if(indices.every(index=>index>=0))samples.push({at:performance.now(),values:indices.map(index=>this.parameters.values[index]),owned:ids.some(id=>store.isTransient(id))})
      return original.apply(this,args)
    }
    prototype.update=wrapped
    globalThis.__tailIdleObservation={samples,cleanup(){if(prototype.update===wrapped)prototype.update=original;return saved===snapshot()}}
    return {model:store.modelId,idle:localStorage.getItem('settings/live2d/idle-animation-enabled'),permission:store.llmMode}
  })
  for(let index=0;index<4;index++){
    await page.waitForTimeout(2000)
    await page.screenshot({path:`${directory}/idle-${index}.png`})
  }
  result.samples=await page.evaluate(()=>globalThis.__tailIdleObservation.samples)
  result.settingsUnchanged=await page.evaluate(()=>{const value=globalThis.__tailIdleObservation.cleanup();delete globalThis.__tailIdleObservation;return value})
  const idleSamples=result.samples.filter(sample=>!sample.owned)
  result.ranges=[0,1,2].map(index=>{const values=idleSamples.map(sample=>sample.values[index]);return {min:Math.min(...values),max:Math.max(...values),range:Math.max(...values)-Math.min(...values)}})
  assert.ok(idleSamples.length>100,'Observe actual unowned idle frames')
  assert.ok(result.settingsUnchanged)
  assert.deepEqual(result.errors,[])
  if(!baseline){
    assert.ok(result.ranges[0].range>5,'Idle tail must visibly move without a performance command')
    assert.ok(result.ranges[0].range<18,'Idle movement stays gentle')
    assert.ok(result.ranges[1].range>1,'Middle segment follows')
    assert.ok(result.ranges[2].range>0.5,'Tail tip follows')
  }
  result.pass=true
}catch(error){result.error=error.message;process.exitCode=1}
finally{
  await page?.evaluate(()=>{globalThis.__tailIdleObservation?.cleanup();delete globalThis.__tailIdleObservation}).catch(()=>{})
  await browser.close()
  writeFileSync(directory+'/report.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify({directory,pass:result.pass??false,baseline,result:result.ranges,settingsUnchanged:result.settingsUnchanged,error:result.error}))
}
