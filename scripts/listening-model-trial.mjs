import {writeFileSync} from 'node:fs'
import {streamParticipation} from '../apps/cohost/participation-stream.mjs'
import {RuntimeProfile} from '../apps/cohost/runtime-profile.mjs'

// Synthetic speech snapshots, real model decisions. No microphone or TTS is used.
if(!process.env.DEEPSEEK_API_KEY)throw Error('Missing local model credential')
const profile=new RuntimeProfile().snapshot()
const examples=[
  {text:'我家的猫把跑步机当成猫窝了，还嫌我跑步吵它睡觉。',kind:'complete-joke'},
  {text:'小鲸鱼，你是不是也觉得它才是这个家的主人？',kind:'direct-question'},
  {text:'我先把事情讲完，昨天我到了那家店，然后老板突然对我说',kind:'unfinished-story'},
  {text:'等一下，先听我说。',kind:'stop'},
  {text:'我家的猫把跑步机当成猫窝了。',tail:'然后它还朝我叫',kind:'complete-clause-with-growing-tail'},
]
const rows=[]
const selected=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7)
if(selected!==undefined && !/^\d$/u.test(selected))throw Error('Invalid case')
for(const example of selected===undefined?examples:[examples[Number(selected)]]) {
  if(!example)throw Error('Unknown case')
  const snapshot={scene:[],history:[],currentTopic:1,hostSpeaking:true,active:false,hostOpportunity:false,
    listeningOpportunity:true,latestHost:{id:1,text:example.text,final:false,startedAt:Date.now(),endedAt:null},
    listening:{text:example.text,stableText:example.text,heardText:example.text+(example.tail??''),confirmed:false},proactiveCooldownMs:0,
    viewerWindow:false,eligibleViewers:[],programOpportunity:false,pendingOpportunity:false}
  const started=Date.now()
  try {
    const result=await streamParticipation(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model:process.env.DEEPSEEK_MODEL||'deepseek-flash',profile,signal:AbortSignal.timeout(10000)})
    rows.push({...example,action:result.action,textOut:result.text,reason:result.reason,decisionMs:Date.now()-started,
      eligibleShortReply:result.action==='reply_host' && result.text.length<=32})
    result.replyStream?.close()
  } catch(error) {rows.push({...example,error:'model_request_failed',code:error.code??error.name,decisionMs:Date.now()-started})}
}
writeFileSync(new URL(`../data/listening-model-trial${selected===undefined?'':'-case-'+selected}.json`,import.meta.url),JSON.stringify({at:new Date().toISOString(),kind:'synthetic-input-real-model-no-audio',rows},null,2)+'\n')
console.log(JSON.stringify(rows))
