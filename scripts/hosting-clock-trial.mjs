import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Hosting } from '../apps/cohost/hosting.mjs'
import { Participation } from '../apps/cohost/participation.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { Scene } from '../apps/cohost/scene.mjs'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'
import { defaultPersona } from '../apps/cohost/runtime-profile.mjs'
import { emptyCapabilities } from '../packages/cohost-contracts/performance.ts'

// Real model, simulated time and synthetic conversation. Never opens a microphone or production room.
if(!process.argv.includes('--real') || !process.env.DEEPSEEK_API_KEY)throw Error('Use --real with the local credential')
const db=new DatabaseSync('data/cohost-session.sqlite',{readOnly:true})
const model=JSON.parse(db.prepare("select payload from module_settings where id='inference'").get().payload).value.model
db.close()
const directory='data/hosting-clock-trial-'+Date.now();mkdirSync(directory,{recursive:true})
const report={method:'Real DeepSeek, isolated state machine with simulated elapsed time and synthetic delivered text. No ASR, TTS, production writes or automatic retries.',model,rows:[]}
report.sourceHashes=Object.fromEntries(['hosting.mjs','live-clock.mjs','participation.mjs','participation-model.mjs','participation-stream.mjs','hosting-closing.mjs','director-manual.md'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../apps/cohost/'+name,import.meta.url))).digest('hex')]))
const profile={prompt:defaultPersona,capabilities:emptyCapabilities()}
const cases=[
  {name:'指定留白到点',elapsed:30000,delay:30,expected:'reply_program'},
  {name:'未指定时长的静默唤醒',elapsed:30000,delay:0,expected:'reply_program'},
  {name:'反复留白后再观察',elapsed:60000,delay:0,repeat:true,expected:'reply_program'},
  {name:'还没到预约时间',elapsed:3000,delay:30,expected:'wait'},
  {name:'人工暂停后时间不授权',elapsed:180000,delay:30,paused:true,expected:'wait'},
]
for(const [index,item] of cases.entries()){
  let now=Date.now()-item.elapsed
  const scheduler=new Scheduler({now:()=>now}),director=new Director({scheduler,now:()=>now}),hosting=new Hosting({now:()=>now}),scene=new Scene()
  director.event({type:'mode',value:'auto'})
  const p=new Participation({scheduler,director,scene,hosting,enabled:true,now:()=>now,
    history:()=>[{role:'user',content:'你先播着，我去忙点别的。今天聊日常的小发现。'},{role:'assistant',content:'我发现，换一条回家路线就像给熟悉的街道打了个补丁。你们最近发现过什么小变化？我先给大家留半分钟想想，接着再聊。'}]})
  hosting.start('日常的小发现')
  hosting.decide({action:'wait',hostingIntent:'listen',hostingPace:'yield',revisitAfterSeconds:item.delay,reason:'留一点时间给大家想想，再从另一个角度接着聊。'})
  if(item.repeat){now+=30000;hosting.tick(scheduler);hosting.decide({action:'wait',hostingIntent:'listen',revisitAfterSeconds:0,reason:'暂时继续留白，稍后再观察。'})}
  if(item.paused)hosting.pause('manual')
  now+=item.elapsed-(item.repeat?30000:0);hosting.tick(scheduler)
  const snapshot=p.context(),row={name:item.name,expected:item.expected,clock:snapshot.clock,hosting:snapshot.hosting,programOpportunity:snapshot.programOpportunity};report.rows.push(row)
  let result
  try {
    result=await streamParticipation(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model,profile,timeoutMs:30000})
    row.action=result.action;row.reason=result.reason;row.records=[]
    if(result.replyStream)for await(const record of result.replyStream)row.records.push(record)
    row.text=result.replyStream?row.records.filter(record=>record.kind==='speech').map(record=>record.text).join(''):result.text
    row.closing=result.replyStream?.hostingClosing??null
    row.pass=result.action===item.expected && !result.hostingControl
  }catch(error){row.error=error.code??error.name;row.pass=false}
  finally {result?.replyStream?.close();p.close();director.close()}
  writeFileSync(directory+'/report.json',JSON.stringify(report,null,2))
  console.log(JSON.stringify({name:row.name,action:row.action,pass:row.pass,reason:row.reason,error:row.error}))
}
report.passed=report.rows.filter(row=>row.pass).length;report.total=report.rows.length
writeFileSync(directory+'/report.json',JSON.stringify(report,null,2))
console.log(JSON.stringify({directory,passed:report.passed,total:report.total}))
if(report.passed!==report.total)process.exitCode=1
