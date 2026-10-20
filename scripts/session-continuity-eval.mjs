import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { SessionContinuity } from '../apps/cohost/session-continuity.mjs'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'

// Explicit opt-in. Real model decisions, simulated delivery, no microphone or production room.
if(!process.argv.includes('--real') || !process.env.DEEPSEEK_API_KEY)throw new Error('Use --real with the local environment configured')
const characterId='builtin:xiaojingyu',memory=new SessionContinuity(),results=[]
const messages=[
  '我先打一局，稍后再聊我家猫把跑步机当床的事，先帮我记着。',
  '这局还剩最后一个怪，我先集中注意力，先别说。',
  '打完了，接着聊刚才猫占跑步机的事吧，你觉得我是不是给猫买了个健身房？',
]
try {
  for(const [index,text] of messages.entries()) {
    const at=Date.now(),latestHost={id:index+1,text,final:true,endedAt:at}
    const snapshot={scene:[{role:'host',text,topic:1,at,id:index+1}],currentTopic:1,history:[],hostOpportunity:true,latestHost,
      proactiveCooldownMs:0,viewerWindow:false,active:false,activeTurn:null,completedTurn:null,completedAt:null,hostSpeaking:false,
      eligibleViewers:[],pendingThought:null,pendingOpportunity:false,stickers:[],...memory.context(characterId,1)}
    const result=await streamParticipation(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model:process.env.DEEPSEEK_MODEL||'deepseek-flash'})
    const firstMs=Date.now()-at,records=[]
    if(result.replyStream)for await(const record of result.replyStream)records.push(record)
    const directive=records.findLast(record=>record.continuation)?.continuation??result.continuation
    const prepared=memory.prepare(directive,{host:latestHost,characterId,topic:1,action:result.action,offered:snapshot.continuations.map(x=>x.id)})
    memory.commit(prepared)
    results.push({input:text,action:result.action,reason:result.reason,text:records.filter(x=>x.kind==='speech').map(x=>x.text).join('')||result.text,
      directive,accepted:Boolean(prepared),firstDecisionMs:firstMs,items:memory.status(characterId,1).items.map(x=>({text:x.text,state:x.state}))})
  }
  writeFileSync('data/continuity-real-model.json',JSON.stringify({provider:'real DeepSeek',delivery:'simulated',productionChanged:false,results},null,2)+'\n')
  assert.equal(results[0].accepted,true,'model must save the explicit request')
  assert.equal(results[1].action,'wait','the busy host keeps the floor')
  assert.equal(results[2].directive?.action,'resume','model must reconnect the explicit return')
  assert.equal(results[2].items[0].state,'resumed')
  console.log(JSON.stringify(results.map(x=>({action:x.action,accepted:x.accepted,firstDecisionMs:x.firstDecisionMs}))))
} finally {memory.close()}
