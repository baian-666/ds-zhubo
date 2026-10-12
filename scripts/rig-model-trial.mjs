import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {streamReply} from '../apps/cohost/deepseek.mjs'
import {performedText} from '../apps/cohost/performance.mjs'
import {planParticipation} from '../apps/cohost/participation-model.mjs'
if(!process.argv.includes('--real')||!process.env.DEEPSEEK_API_KEY)throw Error('Use --real with the local environment credential')
const model=process.env.DEEPSEEK_MODEL||'deepseek-flash'
const input={source:'host',text:'小鲸鱼，你获得了今天的最佳接梗奖！你自己选个符合心情的原生表情，再自己安排手部或尾巴的小动作庆祝一下。别只说你动了，实际编排两段就好。'}
const motions=[],started=Date.now()
let firstMs=null,text=''
const chunks=streamReply({apiKey:process.env.DEEPSEEK_API_KEY,model,input,signal:AbortSignal.timeout(45000)})
for await(const chunk of performedText(chunks,(name,motion)=>{if(motion)motions.push(motion)})){if(firstMs===null)firstMs=Date.now()-started;text+=chunk}
assert.ok(motions.length>0,'Model did not submit a valid plan')
assert.ok(motions.some(motion=>motion.frames.some(frame=>frame.expression||Object.keys(frame.components||{}).length)))
assert.ok(!text.includes('<act'))
const record={kind:'real DeepSeek choice, not a canned fixture',model,firstMs,totalMs:Date.now()-started,text,motions}
writeFileSync('data/rig-model-result.json',JSON.stringify(record,null,2))
console.log(JSON.stringify(record))
if(process.argv.includes('--director')){
  const snapshot={version:1,hostOpportunity:true,hostText:input.text,hostSpeaking:false,active:false,viewerWindow:false,eligibleViewers:[],scene:[{role:'host',text:input.text}],proactiveCooldownMs:0}
  const plannedAt=Date.now()
  const decision=await planParticipation(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model,signal:AbortSignal.timeout(10000)})
  assert.ok(decision.motion,'Director did not submit a valid motion')
  writeFileSync('data/rig-director-result.json',JSON.stringify({kind:'real same-model director choice',elapsedMs:Date.now()-plannedAt,decision},null,2))
  console.log(JSON.stringify({kind:'director',elapsedMs:Date.now()-plannedAt,decision}))
}
