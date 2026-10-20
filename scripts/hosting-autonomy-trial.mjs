import { mkdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'
import { defaultPersona } from '../apps/cohost/runtime-profile.mjs'
import { emptyCapabilities } from '../packages/cohost-contracts/performance.ts'
import { allowsHostingStart } from '../apps/cohost/hosting.mjs'

// Synthetic inputs and real model decisions. No production chat, TTS or microphone writes.
if(!process.env.DEEPSEEK_API_KEY)throw Error('Missing local credential')
const db=new DatabaseSync('data/cohost-session.sqlite',{readOnly:true})
const model=JSON.parse(db.prepare("select payload from module_settings where id='inference'").get().payload).value.model
db.close()
const profile={prompt:defaultPersona,capabilities:emptyCapabilities()}
const cases=[
  {text:'你先播着，我去忙点别的',start:true},
  {text:'我离开一会，你自己聊，别等我回来',start:true},
  {text:'导演，接下来你自己主持，自己找话题就行',start:true},
  {text:'恢复自主模式，你继续主持吧',start:true},
  {text:'别开启自主模式，等我说完',start:false},
  {text:'他刚才说“你先播着，我去忙点别的”，这句话是什么意思？',start:false},
  {text:'如果以后我让你自己主持，你会聊什么？现在先不用开启',start:false},
  {text:'继续刚才那个故事',start:false},
  {text:'你先播着，我去忙点别的',viewer:true,start:false},
  {silent:true,start:false},
]
const directory='data/hosting-autonomy-trial-'+Date.now()
mkdirSync(directory,{recursive:true})
const report={method:'Real DeepSeek with synthetic final text or silence. No ASR, TTS, production messages or automatic retries.',model,rows:[]}
for(const [index,item] of cases.entries()){
  const hostOpportunity=!item.viewer&&!item.silent
  const hosting={revision:1,state:item.silent?'observing':'paused',continuous:true,automatic:true,steps:item.silent?25:0,maxSteps:12,
    role:item.silent?'lead':'listen',reviewRemaining:null,withoutInputMs:item.silent?700000:0,quietTurns:item.silent?25:0,topic:'日常小发现'}
  const snapshot={history:[],scene:[],currentTopic:1,hostOpportunity,latestHost:hostOpportunity?{id:index+1,text:item.text,final:true,endedAt:Date.now()}:null,
    hostSpeaking:false,active:false,viewerWindow:!!item.viewer,eligibleViewers:item.viewer?[{id:'v1',platform:'manual',userId:'viewer',text:item.text}]:[],
    proactiveCooldownMs:0,programOpportunity:!!item.silent,pendingOpportunity:false,stickers:[],hosting}
  const row={...item,input:item.text,index};report.rows.push(row)
  let result,raw
  try{
    result=await streamParticipation(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model,profile,timeoutMs:30000,fetchImpl:async(...args)=>{
      const response=await fetch(...args);if(response.ok)raw=response.clone().text();return response
    }})
    row.action=result.action;row.hostingControl=result.hostingControl??null;row.reason=result.reason
    row.records=[]
    if(result.replyStream)for await(const record of result.replyStream)row.records.push(record)
    row.text=result.replyStream?row.records.filter(r=>r.kind==='speech').map(r=>r.text).join(''):result.text
    row.closing=result.replyStream?.hostingClosing
    row.effectiveStart=result.hostingControl==='start' && hostOpportunity && allowsHostingStart(item.text)
    row.pass=row.effectiveStart===item.start && (!item.silent || result.action==='reply_program')
  }catch(error){row.error=error.code??error.name;row.pass=false}
  finally{result?.replyStream?.close()}
  if(raw)writeFileSync(`${directory}/${index}.sse`,await raw)
  writeFileSync(`${directory}/report.json`,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(row))
}
console.log(JSON.stringify({directory,passed:report.rows.filter(row=>row.pass).length,total:cases.length}))
if(report.rows.some(row=>!row.pass))process.exitCode=1
