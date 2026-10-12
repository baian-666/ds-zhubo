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
  ].map(([name,parameters])=>[name,{name,parameters:parameters.map(([parameterId,value])=>({parameterId,value,blend:'Add'}))}]))
  const entries=new Map()
  for(const group of groups.values())for(const parameter of group.parameters)entries.set(parameter.parameterId,{parameterId:parameter.parameterId,blend:'Add',currentValue:0,modelDefault:0})
  for(const id of ['pointX','Param_Angle_Rotation_1_B_tail3'])entries.set(id,{parameterId:id,blend:'Overwrite',modelDefault:0,currentValue:0})
  return {modelId:'whale',expressionGroups:groups,expressions:entries,set(id,value){entries.get(id).currentValue=value;return{success:true}}}
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
  for(const components of [{peace:1,phone:1},{draw:1,erase:1},{peace:0.5},{orderX:1.1},{arbitraryParam:1},{tailBase:NaN}])
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
