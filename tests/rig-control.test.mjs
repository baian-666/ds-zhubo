import test from 'node:test'
import assert from 'node:assert/strict'
import {RigController} from '../integrations/airi/rig-controller.ts'
import {parseMotionSequence,sampleMotionSequence} from '../integrations/airi/motion-sequence.ts'
import {parseParticipation} from '../apps/cohost/participation-model.mjs'
import {performedText} from '../apps/cohost/performance.mjs'

function store() {
  const groups=new Map([
    ['问号',[['ParamCheek74',1]]],['开心兴奋',[['ParamCheek76',1],['ParamBrowLY',-0.8]]],
    ['双手比耶',[['phone7',1]]],['蛋包饭',[['point',-1],['danbaofan',1]]],
    ['星星眼',[['ParamCheek16',1]]],['哭',[['ParamCheek20',1],['ParamCheek27',1]]],
    ['吐舌',[['ParamCheek79',1],['ParamMouthOpenY',0.75]]],
    ['调皮',[['ParamCheek21',1],['ParamEyeROpen',-1]]],
    ['画笔',[['bi',1]]],['橡皮',[['pi',1]]],['撤回',[['chehui',1]]],
    ['鲸鱼',[['jingyu',1]]],['鲸鱼放桌上',[['fangzhuoshang',1]]],
    ['魔爪',[['mozhua',1]]],['魔爪换色',[['mozhua2',1]]],['挤',[['ji',1]]],
    ['头箍',[['ParamCheek38',3]]],['巴菲',[['baleite',1]]],
  ].map(([name,parameters])=>[name,{name,parameters:parameters.map(([parameterId,value])=>({parameterId,value,blend:'Add'}))}]))
  const entries=new Map()
  for(const group of groups.values())for(const parameter of group.parameters)entries.set(parameter.parameterId,{parameterId:parameter.parameterId,blend:'Add',currentValue:0,modelDefault:0})
  for(const id of ['pointX','Param_Angle_Rotation_1_B_tail3'])entries.set(id,{parameterId:id,blend:'Overwrite',modelDefault:0,currentValue:0})
  const edits=new Map()
  return {llmMode:'all',isExposedToLlm(){return this.llmMode==='all'},getEditRevision:id=>edits.get(id)??0,
    setTransientValue(id,previous,value){entries.get(id).currentValue=value},clearTransient(){},modelId:'whale',expressionGroups:groups,expressions:entries,
    set(id,value){edits.set(id,(edits.get(id)??0)+1);entries.get(id).currentValue=value;return{success:true}}}
}

test('native drawing switches are complete, mutually exclusive, and never own speech mouth opening',()=>{
  const state=store(),rig=new RigController(state)
  rig.apply({name:'星星眼',strength:0.15},{})
  assert.equal(state.expressions.get('ParamCheek16').currentValue,1)
  rig.apply({name:'smile',strength:0.25},{})
  assert.equal(state.expressions.get('ParamCheek16').currentValue,0)
  assert.equal(state.expressions.get('ParamCheek76').currentValue,1)
  assert.equal(state.expressions.get('ParamBrowLY').currentValue,-0.2)
  rig.apply({name:'哭',strength:0.2},{})
  assert.equal(state.expressions.get('ParamCheek76').currentValue,0)
  assert.equal(state.expressions.get('ParamCheek20').currentValue,1)
  rig.apply({name:'调皮',strength:0.2},{})
  assert.equal(state.expressions.get('ParamEyeROpen').currentValue,-1)
  assert.equal(state.expressions.get('ParamCheek21').currentValue,1)
  state.expressions.get('ParamMouthOpenY').currentValue=0.6
  rig.apply({name:'吐舌',strength:1},{})
  assert.equal(state.expressions.get('ParamMouthOpenY').currentValue,0.6)
  rig.restore()
  assert.equal(state.expressions.get('ParamCheek79').currentValue,0)
  assert.equal(state.expressions.get('ParamMouthOpenY').currentValue,0.6)
})

test('component targets use actual units, restore previous settings and preserve edits across expression switches',()=>{
  const state=store(),rig=new RigController(state)
  state.expressions.get('pointX').currentValue=4
  rig.apply({name:'smile',strength:1},{orderX:0.3,tailBase:-0.2})
  assert.equal(state.expressions.get('pointX').currentValue,9)
  assert.equal(state.expressions.get('Param_Angle_Rotation_1_B_tail3').currentValue,-9)
  state.expressions.get('pointX').currentValue=7
  rig.apply({name:'星星眼',strength:1},{orderX:-0.5})
  assert.equal(state.expressions.get('pointX').currentValue,7)
  rig.restore()
  assert.equal(state.expressions.get('pointX').currentValue,7)
  assert.equal(state.expressions.get('Param_Angle_Rotation_1_B_tail3').currentValue,0)
  state.expressionGroups.delete('蛋包饭')
  rig.apply({name:'哭',strength:1},{orderX:0.3})
  assert.equal(state.expressions.get('ParamCheek20').currentValue,0)
})

test('hand switches snap together while continuous components interpolate and retain sparse targets',()=>{
  const sequence=parseMotionSequence({label:'比耶后猫爪',frames:[
    {ms:600,pose:{},components:{peace:1,orderX:0.4}},
    {ms:600,pose:{},components:{catPaws:1}},
  ]})
  assert.ok(sequence)
  let sample=sampleMotionSequence(sequence,200)
  assert.equal(sample.components.orderBoard,1)
  assert.equal(sample.components.peace,0)
  assert.ok(sample.components.orderX>0&&sample.components.orderX<0.4)
  sample=sampleMotionSequence(sequence,1700)
  assert.equal(sample.components.peace,0)
  assert.equal(sample.components.catPaws,1)
  assert.equal(sample.components.orderBoard,0)
  assert.equal(sample.components.orderX,0.4)
  const lower=parseMotionSequence({label:'放下比耶手',frames:[{ms:300,pose:{},components:{peace:1}},{ms:300,pose:{},components:{peace:0}}]})
  sample=sampleMotionSequence(lower,1400)
  assert.equal(sample.components.peace,0)
  assert.equal(sample.components.orderBoard,1)
  for(const components of [{peace:1,phone:1},{omelet:1,peace:1},{omelet:0.5},{draw:1,erase:1},{peace:0.5},{orderX:1.1},{arbitraryParam:1},{constructor:1},{tailBase:NaN}])
    assert.equal(parseMotionSequence({label:'无效',frames:[{ms:500,pose:{},components}]}),null)
})

test('one model result can select native expressions and components without leaking control text',async()=>{
  const motion={label:'眼睛亮了摇尾巴',frames:[{ms:700,pose:{},expression:{name:'星星眼',strength:0.7},components:{tailBase:0.3,peace:1}}]}
  const args={action:'react',hostIntent:'none',performance:'idle',text:'✨',reason:'太有趣了。',targetId:'',platform:'',motion}
  const parsed=parseParticipation({tool_calls:[{function:{name:'participate',arguments:JSON.stringify(args)}}]})
  assert.deepEqual(parsed.motion,motion)
  const received=[]
  const text=await Array.fromAsync(performedText(['这个好玩！<act>'+JSON.stringify(motion)+'</act>再来一次。'],(name,plan)=>received.push(plan)))
  assert.equal(text.join(''),'这个好玩！再来一次。')
  assert.deepEqual(received,[motion])
})

test('native permission blocks aliases and direct components and restores an active expression',()=>{
 const state=store(),rig=new RigController(state)
 rig.apply({name:'smile',strength:1},{tailBase:1})
 assert.equal(state.expressions.get('ParamCheek76').currentValue,1)
 state.llmMode='none'
 rig.apply({name:'smile',strength:1},{tailBase:1})
 assert.equal(state.expressions.get('ParamCheek76').currentValue,0)
 assert.equal(state.expressions.get('Param_Angle_Rotation_1_B_tail3').currentValue,0)
 state.llmMode='custom';state.isExposedToLlm=name=>name==='问号'
 rig.apply({name:'think',strength:1},{tailBase:1})
 assert.equal(state.expressions.get('ParamCheek74').currentValue,1)
 assert.equal(state.expressions.get('Param_Angle_Rotation_1_B_tail3').currentValue,0)
})

test('serving omelet with a smile switches the prop, allows squeezing, and restores the board',()=>{
 const state=store(),rig=new RigController(state)
 Object.assign(state.expressions.get('point'),{modelDefault:1,currentValue:1})
 state.expressions.set('ji',{parameterId:'ji',blend:'Add',modelDefault:0,currentValue:0})
 const plan=parseMotionSequence({label:'端饭',frames:[
   {ms:200,holdMs:800,pose:{},expression:{name:'smile',strength:1},components:{omelet:1}},
   {ms:200,holdMs:800,pose:{},components:{squeeze:0.6}},
 ]})
 assert.ok(plan,'The prop must be available separately from the facial expression')
 for(const time of [500,1500]) {
   const sample=sampleMotionSequence(plan,time)
   rig.apply(sample.expressions,sample.components)
   assert.equal(state.expressions.get('danbaofan').currentValue,1)
   assert.equal(state.expressions.get('point').currentValue,-1)
   assert.equal(state.expressions.get('ParamCheek76').currentValue,1)
 }
 assert.equal(state.expressions.get('ji').currentValue,0.6)
 rig.restore()
 assert.equal(state.expressions.get('danbaofan').currentValue,0)
 assert.equal(state.expressions.get('point').currentValue,1)
 assert.equal(state.expressions.get('ji').currentValue,0)
})

test('a named hand expression replaces inherited hand component targets',()=>{
 const state=store(),rig=new RigController(state)
 Object.assign(state.expressions.get('point'),{modelDefault:1,currentValue:1})
 const plan=parseMotionSequence({label:'比耶再端饭',frames:[
   {ms:200,holdMs:800,pose:{},components:{peace:1}},
   {ms:200,holdMs:800,pose:{},expression:{name:'蛋包饭',strength:1}},
 ]})
 for(const time of [500,1500]) {const sample=sampleMotionSequence(plan,time);rig.apply(sample.expressions,sample.components)}
 assert.equal(state.expressions.get('danbaofan').currentValue,1)
 assert.equal(state.expressions.get('phone7').currentValue,0)
 assert.equal(state.expressions.get('point').currentValue,-1)
})

test('manual face edits take over the whole family while unrelated tail animation continues',()=>{
 const state=store(),rig=new RigController(state)
 rig.apply({name:'调皮',strength:1},{tailBase:0.2})
 state.set('ParamCheek21',1) // Same-value edits are still explicit human control.
 state.set('ParamEyeROpen',-1)
 rig.apply({name:'smile',strength:1},{tailBase:0.4})
 assert.equal(state.expressions.get('ParamCheek21').currentValue,1)
 assert.equal(state.expressions.get('ParamCheek76').currentValue,0)
 assert.equal(state.expressions.get('ParamEyeROpen').currentValue,-1)
 assert.equal(rig.permitsPose('eyeSquint'),false)
 assert.equal(state.expressions.get('Param_Angle_Rotation_1_B_tail3').currentValue,18)
 rig.restore()
 assert.equal(state.expressions.get('ParamCheek21').currentValue,1)
 assert.equal(state.expressions.get('Param_Angle_Rotation_1_B_tail3').currentValue,0)
 rig.apply({name:'smile',strength:1},{})
 assert.equal(state.expressions.get('ParamCheek76').currentValue,1,'A new lease can perform again')
 rig.restore()
})

test('named props survive facial changes and detail actions within the same sequence',()=>{
 for(const [first,second,parameter,detail,value] of [
   ['蛋包饭','挤','danbaofan','ji',1],
   ['魔爪','魔爪换色','mozhua','mozhua2',1],
   ['魔爪','smile','mozhua','ParamCheek76',1],
   ['头箍','smile','ParamCheek38','ParamCheek76',3],
 ]){
   const state=store(),rig=new RigController(state)
   const plan=parseMotionSequence({label:'道具后续动作',frames:[first,second].map(name=>({ms:200,holdMs:800,pose:{},expression:{name,strength:1}}))})
   for(const time of [500,1500]){const sample=sampleMotionSequence(plan,time);rig.apply(sample.expressions,sample.components)}
   assert.equal(state.expressions.get(parameter).currentValue,value,first+' must remain while '+second)
   assert.equal(state.expressions.get(detail).currentValue,1)
   rig.restore()
   assert.equal(state.expressions.get(parameter).currentValue,0)
 }
})

test('drawing toolbar selections do not remove the default hands and remain mutually exclusive',()=>{
 const state=store(),rig=new RigController(state)
 Object.assign(state.expressions.get('point'),{modelDefault:1,currentValue:1})
 rig.apply({name:'画笔',strength:1},{})
 assert.equal(state.expressions.get('point').currentValue,1)
 assert.equal(state.expressions.get('bi').currentValue,1)
 rig.apply({name:'橡皮',strength:1},{})
 assert.equal(state.expressions.get('bi').currentValue,0)
 assert.equal(state.expressions.get('pi').currentValue,1)
 assert.equal(state.expressions.get('point').currentValue,1)
})

test('layered named props respect permission revocation and manual edits',()=>{
 const state=store(),rig=new RigController(state)
 const layers=[{name:'魔爪',strength:1},{name:'smile',strength:1}]
 rig.apply(layers,{})
 assert.equal(state.expressions.get('mozhua').currentValue,1)
 state.set('mozhua',0)
 rig.apply(layers,{})
 assert.equal(state.expressions.get('mozhua').currentValue,0)
 assert.equal(state.expressions.get('ParamCheek76').currentValue,1)
 state.llmMode='custom';state.isExposedToLlm=name=>name==='魔爪'
 rig.apply(layers,{})
 assert.equal(state.expressions.get('ParamCheek76').currentValue,0)
 rig.restore()
 assert.equal(state.expressions.get('mozhua').currentValue,0)
})

test('prop slots can be explicitly lowered and whale locations replace each other',()=>{
 const state=store(),rig=new RigController(state)
 const plan=parseMotionSequence({label:'鲸鱼位置与饮料收起',frames:[
   {ms:200,holdMs:400,pose:{},expression:{name:'魔爪',strength:1}},
   {ms:200,holdMs:400,pose:{},expression:{name:'鲸鱼',strength:1}},
   {ms:200,holdMs:400,pose:{},expression:{name:'鲸鱼放桌上',strength:1}},
   {ms:200,holdMs:400,pose:{},expression:{name:'魔爪',strength:0}},
 ]})
 for(const time of [400,1000,1600]){const sample=sampleMotionSequence(plan,time);rig.apply(sample.expressions,sample.components)}
 assert.equal(state.expressions.get('mozhua').currentValue,1)
 assert.equal(state.expressions.get('jingyu').currentValue,0)
 assert.equal(state.expressions.get('fangzhuoshang').currentValue,1)
 const sample=sampleMotionSequence(plan,2200);rig.apply(sample.expressions,sample.components)
 assert.equal(state.expressions.get('mozhua').currentValue,0)
 assert.equal(state.expressions.get('fangzhuoshang').currentValue,1)
 for(const components of [{whaleBuddy:1,whaleOnDesk:1},{draw:1,undo:1},{erase:1,undo:1}])
   assert.equal(parseMotionSequence({label:'互斥',frames:[{ms:300,pose:{},components}]}),null)
})

test('component and named toolbar transitions share one family without releasing unrelated props',()=>{
 const state=store(),rig=new RigController(state)
 const plan=parseMotionSequence({label:'按钮切换',frames:[
   {ms:200,holdMs:400,pose:{},expression:{name:'魔爪',strength:1},components:{draw:1}},
   {ms:200,holdMs:400,pose:{},expression:{name:'橡皮',strength:1}},
   {ms:200,holdMs:400,pose:{},components:{undo:1}},
 ]})
 for(const [time,id] of [[400,'bi'],[1000,'pi'],[1600,'chehui']]){
   const sample=sampleMotionSequence(plan,time);rig.apply(sample.expressions,sample.components)
   assert.equal(state.expressions.get(id).currentValue,1)
   assert.equal(['bi','pi','chehui'].reduce((sum,p)=>sum+state.expressions.get(p).currentValue,0),1)
   assert.equal(state.expressions.get('mozhua').currentValue,1)
 }
})

test('named and component controls hand off the same prop without hiding unrelated hands',()=>{
 const state=store(),rig=new RigController(state)
 const plan=parseMotionSequence({label:'混合控制',frames:[
   {ms:200,holdMs:400,pose:{},components:{beverage:0},expression:{name:'蛋包饭',strength:1}},
   {ms:200,holdMs:400,pose:{},components:{orderBoard:0},expression:{name:'魔爪',strength:1}},
 ]})
 for(const time of [400,1000]){const sample=sampleMotionSequence(plan,time);rig.apply(sample.expressions,sample.components)}
 assert.equal(state.expressions.get('danbaofan').currentValue,1)
 assert.equal(state.expressions.get('mozhua').currentValue,1)
})
