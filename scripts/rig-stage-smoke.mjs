import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {nativeExpressions,componentBindings} from '../integrations/airi/whale-rig.ts'
import {sampleMotionSequence} from '../integrations/airi/motion-sequence.ts'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright')
const desktop=await chromium.connectOverCDP('http://127.0.0.1:9250')
const stage=desktop.contexts()[0].pages().find(page=>page.url().includes('synced-leader=true'))
assert.ok(stage,'Desktop must be running')
const web=await chromium.launch({channel:'msedge',headless:true})
const page=await web.newPage({viewport:{width:1400,height:950},locale:'zh-CN'})
const pages=[stage,page],errors=[]
const headers={'Content-Type':'application/json',...(process.env.COHOST_ACCESS_TOKEN?{Authorization:'Bearer '+process.env.COHOST_ACCESS_TOKEN}:{})}
const call=async(path,body)=>{const response=await fetch('http://127.0.0.1:8787/api/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});assert.equal(response.status,200);return response.json()}
const play=motion=>call('performance',{name:'sequence',motion})
const wait=(target,id,value)=>target.waitForFunction(({id,value})=>{
  const entry=document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressions.get(id)
  return entry&&Math.abs(entry.currentValue-value)<0.001
},{id,value},{timeout:6000})
async function core(target,ids){return target.evaluate(ids=>{
  let el=document.querySelector('canvas');while(el&&!el.__vueParentComponent)el=el.parentElement
  let scene=el.__vueParentComponent;while(scene&&scene.type.__name!=='Live2D')scene=scene.parent
  const model=scene.devtoolsRawSetupState.live2dModelRef.value.$.devtoolsRawSetupState.model.value.internalModel.coreModel
  return Object.fromEntries(ids.map(id=>[id,model.getParameterValueById(id)]))
},ids)}
const result={kind:'manual commands + actual desktop/web whale rendering',expressions:[],components:[],errors}
let started=false
try{
  const status=await call('status');assert.equal(status.busy,false);assert.equal(status.airi.active,false);assert.equal(status.muted,false)
  await page.addInitScript(()=>localStorage.setItem('onboarding/completed','true'))
  for(const target of pages)target.on('pageerror',error=>errors.push(error.message))
  await stage.reload();await page.goto('http://127.0.0.1:5173/?cohost')
  for(const target of pages)await target.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('live2d-expressions')?.expressions.has('Param_Angle_Rotation_1_B_tail3'),null,{timeout:60000})
  started=true
  if(process.argv.includes('--model-plan')){
    const chosen=JSON.parse(readFileSync('data/rig-model-result.json','utf8'))
    const motion=chosen.motions[0]
    await play(motion)
    const start=(await call('status')).performance.startedAt
    let elapsed=0
    for(const frame of motion.frames){
      const targetTime=elapsed+frame.ms+Math.min(150,frame.holdMs??800)
      const delay=start+targetTime-Date.now()
      if(delay>0)await page.waitForTimeout(delay)
      const sample=sampleMotionSequence(motion,targetTime)
      for(const target of pages){
        const values=await core(target,Object.keys(sample.components).map(axis=>componentBindings[axis].id))
        for(const [axis,amount]of Object.entries(sample.components)){
          const binding=componentBindings[axis],expected=binding.min<0?amount*binding.max:amount*(binding.max-binding.min)
          assert.ok(Math.abs(values[binding.id]-expected)<0.05,'AI component did not reach model: '+axis)
        }
        result.components.push({runtime:target===stage?'desktop':'web',label:motion.label,values})
      }
      await stage.screenshot({path:'data/rig-ai-frame-'+result.components.length+'.png'})
      elapsed+=frame.ms+(frame.holdMs??800)
    }
    result.modelChoice={model:chosen.model,text:chosen.text,motion}
  }
  else{
  for(const name of nativeExpressions){
    console.log('Checking native project:',name)
    await play({label:'原生项目 '+name,frames:[{ms:200,holdMs:1200,pose:{},expression:{name,strength:1}}]})
    for(const target of pages){
      const parameters=await target.evaluate(name=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').expressionGroups.get(name).parameters,name)
      for(const parameter of parameters){
        if(parameter.parameterId==='ParamMouthOpenY')continue
        try{await wait(target,parameter.parameterId,parameter.value)}catch(error){throw new Error((target===stage?'desktop':'web')+' '+name+' '+parameter.parameterId+' did not activate',{cause:error})}
      }
    }
    result.expressions.push(name)
    if(['星星眼','哭','脸红','双手比耶','喵喵手~喵~动画'].includes(name))await stage.screenshot({path:'data/rig-native-'+name+'.png'})
    if(result.expressions.length%8===0)console.log('Native projects verified:',result.expressions.length)
  }
  // Verify the core values after the rig's final expression plugin, not only store targets.
  const components={orderBoard:1,orderX:0.4,orderY:-0.25,orderPress:0.6,tailBase:0.3,tailMid:-0.2,tailTip:0.25,hairTuft:0.3}
  await play({label:'自行移动手和尾巴',frames:[{ms:300,holdMs:1500,pose:{},expression:{name:'脸红',strength:0.5},components}]})
  for(const target of pages){
    for(const [axis,amount]of Object.entries(components)){
      const b=componentBindings[axis],value=b.min<0?amount*b.max:amount*(b.max-b.min)
      const offset=await target.evaluate(id=>{const entry=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('live2d-expressions').expressions.get(id);return entry.blend==='Add'?entry.modelDefault:0},b.id)
      await wait(target,b.id,value-offset)
    }
    const values=await core(target,Object.keys(components).map(axis=>componentBindings[axis].id))
    for(const [axis,amount]of Object.entries(components)){const b=componentBindings[axis],expected=b.min<0?amount*b.max:amount*(b.max-b.min);assert.ok(Math.abs(values[b.id]-expected)<0.05,axis+' did not reach the real model')}
    result.components.push({runtime:target===stage?'desktop':'web',values})
  }
  await stage.screenshot({path:'data/rig-components-desktop.png'})
  // Both drawing switches must remain full and only one replacement eye group active.
  await play({label:'星星眼切笑眼',frames:[{ms:300,holdMs:400,pose:{},expression:{name:'星星眼',strength:0.3}},{ms:500,holdMs:500,pose:{},expression:{name:'开心兴奋',strength:0.25}}]})
  for(let i=0;i<18;i++){
    for(const target of pages){const values=await core(target,['ParamCheek16','ParamCheek76']);for(const value of Object.values(values))assert.ok(Math.abs(value)<0.001||Math.abs(value-1)<0.001);assert.ok(values.ParamCheek16+values.ParamCheek76<=1.001)}
    await page.waitForTimeout(60)
  }
  }
  await call('interrupt',{})
  for(const target of pages)await wait(target,'ParamCheek76',0)
  for(const target of pages)await wait(target,'Param_Angle_Rotation_1_B_tail3',0)
  assert.deepEqual(errors,[])
  writeFileSync(process.argv.includes('--model-plan')?'data/rig-ai-stage-result.json':'data/rig-stage-result.json',JSON.stringify(result,null,2))
  console.log(JSON.stringify({pass:true,expressions:result.expressions.length,runtimes:result.components.map(item=>item.runtime),errors}))
}finally{
  if(started)await call('performance',{name:'idle'}).catch(()=>{})
  await web.close();await desktop.close()
}
