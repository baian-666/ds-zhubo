import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { observeDirector } from '../apps/cohost/director-observation.mjs'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'
import { liveClock } from '../apps/cohost/live-clock.mjs'
import { defaultPersona } from '../apps/cohost/runtime-profile.mjs'
import { emptyCapabilities } from '../packages/cohost-contracts/performance.ts'

if(!process.argv.includes('--real') || !process.env.DEEPSEEK_API_KEY)throw Error('Use --real with the local model credential')
const db=new DatabaseSync('data/cohost-session.sqlite',{readOnly:true})
const model=JSON.parse(db.prepare("select payload from module_settings where id='inference'").get().payload).value.model;db.close()
const directory='data/director-observation-trial-'+Date.now();mkdirSync(directory,{recursive:true})
const profile={name:'小鲸鱼',prompt:defaultPersona,capabilities:emptyCapabilities()}
const report={method:'Real DeepSeek with synthetic live context and simulated elapsed time. No ASR, TTS, production chat, automatic retries or required speaking deadline.',model,rows:[]}
report.sourceHashes=Object.fromEntries(['director-observation.mjs','hosting.mjs','participation.mjs','participation-model.mjs','participation-stream.mjs','hosting-closing.mjs','director-manual.md'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../apps/cohost/'+name,import.meta.url))).digest('hex')]))
const cases=[{name:'刚邀请观众3秒',seconds:3,wait:true},{name:'安静18秒',seconds:18},{name:'安静47秒',seconds:47},{name:'安静91秒',seconds:91},
  {name:'8秒但有想继续展开的具体内容',seconds:8,continuing:true,speak:true},{name:'人工暂停',seconds:180,paused:true,wait:true}]
let previous=null
for(const item of cases){
  const snapshot={clock:liveClock(),scene:[{role:'host',text:'你先播着，我去忙点别的。聊聊日常的小发现吧。'},{role:'assistant',text:'换条回家路线就像给熟悉的街道打了个补丁。你们最近遇到过什么小变化？我先听听大家。',deliveryState:'complete'}],
    history:[],hostOpportunity:false,latestHost:null,hostSpeaking:false,active:false,eligibleViewers:[],viewerWindow:true,pendingOpportunity:false,programOpportunity:false,
    hosting:{revision:1,state:item.paused?'paused':'waiting',continuous:true,awarenessMode:'continuous',role:'listen',lastHandoff:'audience',topic:'日常的小发现',quietMs:item.seconds*1000,pauseElapsedMs:item.seconds*1000,audienceWaitMs:item.seconds*1000,withoutInputMs:(item.seconds+30)*1000,observation:previous,nextReviewAt:null}}
  if(item.continuing){snapshot.scene[1].text='刚才聊的是看见的变化，我还想聊聊声音：同一条路，在不同季节为什么像不同的地方。';snapshot.hosting.lastHandoff='continue';snapshot.hosting.role='lead';snapshot.hosting.audienceWaitMs=null}
  const row={name:item.name,seconds:item.seconds};report.rows.push(row)
  try {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000)
    try {row.observation=await observeDirector(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model,profile,signal:controller.signal})}finally{clearTimeout(timer)}
    previous=row.observation
    row.pass=(!item.wait || row.observation.choice==='wait') && (!item.speak || row.observation.choice==='consider_speaking')
    if(row.observation.choice==='consider_speaking' && !report.generated){
      report.generated=true;snapshot.programOpportunity=true;snapshot.hosting.state='observing';snapshot.hosting.observation=row.observation
      const result=await streamParticipation(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model,profile})
      try {
        row.action=result.action;row.reason=result.reason;row.records=[]
        if(result.replyStream)for await(const record of result.replyStream)row.records.push(record)
        row.closing=result.replyStream?.hostingClosing
        row.pass=row.pass && ['reply_program','wait'].includes(row.action) && !row.closing?.revisitAfterSeconds
      }finally{result.replyStream?.close()}
    }
  }catch(error){row.error=error.code??error.name;row.pass=false}
  writeFileSync(directory+'/report.json',JSON.stringify(report,null,2))
  console.log(JSON.stringify(row))
}
report.passed=report.rows.filter(row=>row.pass).length;report.total=report.rows.length
writeFileSync(directory+'/report.json',JSON.stringify(report,null,2))
console.log(JSON.stringify({directory,passed:report.passed,total:report.total,generated:!!report.generated}))
if(report.passed!==report.total)process.exitCode=1
