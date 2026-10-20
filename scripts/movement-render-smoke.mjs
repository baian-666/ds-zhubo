import assert from 'node:assert/strict'
import {once} from 'node:events'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
import {sequenceDuration} from '../packages/cohost-contracts/motion.ts'

// Exercise the real local model in an isolated browser and backend, with no providers.
const {chromium}=await import('../vendor/airi/node_modules/playwright/index.mjs')
const server=createApp({apiKey:'fixture',token:'',reply:async function*(){yield '动作检查。'}})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const directory='data/movement-render-'+Date.now();mkdirSync(directory)
const browser=await chromium.launch({channel:'msedge',headless:true})
const context=await browser.newContext({viewport:{width:1500,height:1050},locale:'zh-CN',recordVideo:{dir:directory}})
const errors=[],publications=[],result={kind:'Real browser and whale rendering; specified motions, no model/audio calls',errors,rows:[]}
await context.addInitScript(()=>{localStorage.setItem('onboarding/completed','true');localStorage.setItem('cohost/enabled','true');localStorage.setItem('settings/live2d/idle-animation-enabled','false')})
await context.route('http://127.0.0.1:8787/api/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/api/runtime-profile')publications.push(route.request().postDataJSON())
  if(path==='/api/status/events')return route.continue({url:base+path})
  await route.fulfill({response:await route.fetch({url:base+path})})
})
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message))
const post=async(path,body)=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json()}
try{
  await page.goto(base)
  const frame=await page.locator('#stage').elementHandle().then(h=>h.contentFrame())
  await frame.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressions.has('Param_Angle_Rotation_1_B_tail3'),null,{timeout:120000})
  await frame.evaluate(()=>{
    const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions');store.setLlmMode('all')
    let element=document.querySelector('canvas');while(element&&!element.__vueParentComponent)element=element.parentElement
    let scene=element.__vueParentComponent;while(scene&&scene.type.__name!=='Live2D')scene=scene.parent
    const internal=scene.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState.model.value.internalModel
    // Cubism restores saved parameters after mesh update. Read at the render boundary,
    // after physics, rather than mistaking the restored pre-physics value for pixels.
    const ids=['Param_Angle_Rotation_1_B_tail3','Param_Angle_Rotation_2_B_tail3','Param_Angle_Rotation_3_B_tail3','ParamAngleX','ParamAngleY','ParamAngleZ']
    globalThis.__movementRender=[]
    let natural={}
    const evaluate=internal.physics.evaluate.bind(internal.physics)
    internal.physics.evaluate=(...args)=>{const result=evaluate(...args);natural=Object.fromEntries(ids.map(id=>[id,internal.coreModel.getParameterValueById(id)]));return result}
    internal.on('beforeModelUpdate',()=>{
      const control=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-motion-control').control
      globalThis.__movementRender.push({at:performance.now(),natural,values:Object.fromEntries(ids.map(id=>[id,internal.coreModel.getParameterValueById(id)])),stored:Object.fromEntries(ids.map(id=>[id,store.expressions.get(id)?.currentValue])),pose:control.pose,axes:control.axes})
      if(globalThis.__movementRender.length>600)globalThis.__movementRender.shift()
    })
  })
  await page.waitForTimeout(600)
  result.capabilities=publications.at(-1)?.capabilities
  await page.locator('#stage').screenshot({path:directory+'/neutral.png'})
  for(const [name,sign] of [['right',1],['left',-1]]){
    const motion={label:'尾巴方向检查',frames:[{ms:500,holdMs:1200,pose:{},components:{tailBase:sign*0.6,tailMid:sign*0.22,tailTip:sign*0.12}}]}
    await post('performance',{name:'sequence',motion})
    await page.waitForTimeout(850)
    const frames=await frame.evaluate(()=>globalThis.__movementRender.slice(-5))
    result.rows.push({name,motion,frames})
    await page.locator('#stage').screenshot({path:directory+'/'+name+'.png'})
    await page.waitForTimeout(1100)
  }
  const nod={label:'轻点头回正',frames:[{ms:400,holdMs:150,pose:{headY:-0.14}},{ms:500,holdMs:200,pose:{headY:0}}]}
  await post('performance',{name:'sequence',motion:nod});await page.waitForTimeout(450)
  result.head=await frame.evaluate(()=>globalThis.__movementRender.slice(-5))
  await page.locator('#stage').screenshot({path:directory+'/head.png'})
  await page.waitForTimeout(1300)
  result.restored=await frame.evaluate(()=>globalThis.__movementRender.slice(-5))
  result.tailMatches=result.rows.every(row=>row.frames.every(sample=>Object.entries(row.motion.frames[0].components).every(([axis,value])=>{
    const index=['tailBase','tailMid','tailTip'].indexOf(axis)+1
    const id=`Param_Angle_Rotation_${index}_B_tail3`
    const headroom=value>0?45-sample.natural[id]:sample.natural[id]+45
    const expected=sample.natural[id]+headroom*Math.tanh(value*45/headroom)
    return Math.abs(sample.values[id]-expected)<0.2
  })))
  assert.ok(result.restored.every(sample=>['1','2','3'].every(index=>{
    const id=`Param_Angle_Rotation_${index}_B_tail3`
    return Math.abs(sample.values[id]-sample.natural[id])<0.05
  })),'Released tail returns to native physics')
  assert.equal(result.tailMatches,true,'Physics must not overwrite an actively owned tail parameter')
  const tailIds=['1','2','3'].map(index=>`Param_Angle_Rotation_${index}_B_tail3`)
  const offset=(sample,index=0)=>sample.values[tailIds[index]]-sample.natural[tailIds[index]]
  const wave={label:'柔软往返摇尾',frames:[
    {ms:450,holdMs:0,pose:{},components:{tailBase:0.6,tailMid:0.22,tailTip:0.12}},
    {ms:550,holdMs:0,pose:{},components:{tailBase:-0.6,tailMid:-0.22,tailTip:-0.12}},
    {ms:600,holdMs:0,pose:{},components:{tailBase:0,tailMid:0,tailTip:0}},
  ]}
  await frame.evaluate(()=>{globalThis.__movementRender=[]})
  await post('performance',{name:'sequence',motion:wave})
  for(const [name,ms] of [['start',280],['swing-right',220],['reverse',300],['swing-left',300],['settle',600]]){
    await page.waitForTimeout(ms)
    await page.locator('#stage').screenshot({path:directory+'/wave-'+name+'.png'})
  }
  await page.waitForTimeout(1000)
  result.wave={motion:wave,samples:await frame.evaluate(()=>globalThis.__movementRender)}
  const offsets=result.wave.samples.map(sample=>offset(sample))
  result.wave.min=Math.min(...offsets);result.wave.max=Math.max(...offsets)
  assert.ok(result.wave.min<-10&&result.wave.max>15,'Elastic wave reaches both visible directions')
  assert.ok(Math.abs(offsets.at(-1))<0.05,'Elastic wave settles at native physics')
  assert.ok(result.wave.samples.every(sample=>tailIds.every(id=>sample.values[id]>-45&&sample.values[id]<45)),'Wave avoids hard clipping')
  assert.ok(result.wave.samples.every(sample=>['ParamAngleX','ParamAngleY','ParamAngleZ'].every(id=>sample.values[id]===sample.natural[id])),'Tail motion does not add head gestures')
  await post('performance',{name:'sequence',motion:{label:'提前收尾',frames:[{ms:200,holdMs:1800,pose:{},components:{tailBase:0.6,tailMid:0.22,tailTip:0.12}}]}})
  await page.waitForTimeout(850)
  await frame.evaluate(()=>{globalThis.__movementRender=[]})
  await post('performance',{name:'idle'})
  await page.waitForTimeout(1200)
  result.release=await frame.evaluate(()=>globalThis.__movementRender)
  const release=result.release.map(sample=>offset(sample))
  assert.ok(release[0]>5,'Early release retains position instead of snapping to zero')
  assert.ok(Math.min(...release)<-0.1,'Early release has a small elastic rebound')
  assert.ok(Math.abs(release.at(-1))<0.05,'Early release settles at zero')
  await post('performance',{name:'sequence',motion:wave})
  await page.waitForTimeout(350)
  await frame.evaluate(()=>{
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').setLlmMode('none')
    globalThis.__movementRender=[]
  })
  await page.waitForTimeout(250)
  result.revoked=await frame.evaluate(()=>globalThis.__movementRender)
  assert.ok(result.revoked.length>0)
  assert.ok(result.revoked.every(sample=>tailIds.every((id,index)=>Math.abs(offset(sample,index))<0.05)),'Permission revocation immediately clears momentum')
  await post('performance',{name:'idle'})
  await frame.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').setLlmMode('all'))
  for(let n=0;n<50&&!publications.at(-1)?.capabilities.components.some(item=>item.name==='tailBase');n++)await page.waitForTimeout(100)
  await post('performance',{name:'sequence',motion:wave})
  await page.waitForTimeout(350)
  await frame.evaluate(()=>{
    const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions')
    store.set('Param_Angle_Rotation_2_B_tail3',12)
    globalThis.__movementRender=[]
  })
  await page.waitForTimeout(250)
  result.manual=await frame.evaluate(()=>globalThis.__movementRender)
  assert.ok(result.manual.length>0)
  assert.ok(result.manual.every(sample=>tailIds.every((id,index)=>Math.abs(offset(sample,index))<0.05)),'Manual takeover immediately clears the whole tail')
  const trialPath=process.argv.find(arg=>arg.startsWith('--trial='))?.slice(8)
  if(trialPath){
    const trial=JSON.parse(readFileSync(trialPath,'utf8'))
    result.generated=[]
    for(const row of trial.results.filter(row=>row.filtered?.motion)){
      const motion=row.filtered.motion
      await frame.evaluate(()=>{globalThis.__movementRender=[]})
      await post('performance',{name:'sequence',motion})
      await page.waitForTimeout(sequenceDuration(motion)+500)
      const samples=await frame.evaluate(()=>globalThis.__movementRender)
      const tailId='Param_Angle_Rotation_1_B_tail3'
      const offsets=samples.map(s=>s.values[tailId]-s.natural[tailId])
      const evidence={input:row.text,motion,samples,tailMin:Math.min(...offsets),tailMax:Math.max(...offsets)}
      result.generated.push(evidence)
      if(motion.frames.some(f=>f.components?.tailBase>0)&&motion.frames.some(f=>f.components?.tailBase<0)){
        assert.ok(evidence.tailMin<-10&&evidence.tailMax>10,'Generated tail wave reaches both visible directions')
        assert.ok(Math.abs(offsets.at(-1))<0.05,'Generated tail gesture returns to native physics')
      }
    }
  }
  assert.deepEqual(errors,[]);result.pass=true
}catch(error){result.error=error.message;process.exitCode=1}
finally{
  writeFileSync(directory+'/report.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify({directory,pass:result.pass??false,error:result.error,tailMatches:result.tailMatches,rows:result.rows.map(row=>({name:row.name,last:row.frames.at(-1)}))}))
  await context.unrouteAll({behavior:'ignoreErrors'});await context.close();console.log('Video: '+await page.video().path());await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
