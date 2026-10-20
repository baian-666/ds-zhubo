import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DirectorTools } from '../apps/cohost/director-tools.mjs'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'

if(!process.argv.includes('--real') || !process.env.DEEPSEEK_API_KEY)throw Error('Use --real with the local provider credential')
const output=resolve('data/director-mcp-trial-'+Date.now()+'.json'),rows=[]
mkdirSync(resolve('data'),{recursive:true})
const owner=new DirectorTools()
const report={method:'Real DeepSeek + real Exa MCP; synthetic live context, no production DB, ASR, TTS or live broadcast. No retries.',model:process.env.DEEPSEEK_MODEL||'deepseek-flash',rows}
const cases=[
  {name:'普通闲聊不查询',text:'我家猫又把跑步机当成床了，你觉得好不好笑？',expected:[]},
  {name:'直播现场',text:'帮我读一下当前直播现场状态，现在主持是在运行还是暂停？',expected:['live_context']},
  {name:'公开搜索',text:'请上网找国际天文学联合会的公开资料，冥王星为什么属于矮行星？简短说两句并提一下来源。',expected:['web_search']},
  {name:'读取指定网页',text:'请读一下这个公开网页 https://www.iau.org/IAU/IAU/News/PR2006/iau-2006-general-assembly-resolution-votes.aspx 告诉我里面关于冥王星分类的要点。',expected:['web_read'],urls:['https://www.iau.org/IAU/IAU/News/PR2006/iau-2006-general-assembly-resolution-votes.aspx']},
]
try {
  for(const [index,item] of cases.entries()) {
    const start=Date.now(),row={name:item.name,input:item.text,expected:item.expected,records:[]};rows.push(row)
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000)
    const information=owner.session({characterId:String(index),signal:controller.signal,urls:item.urls,
      readLive:()=>({live:true,hosting:{state:'paused'},hostSpeaking:false,recentMessages:[{role:'host',text:'这是一场隔离测试。'}]})})
    let result
    try {
      result=await streamParticipation({scene:[],history:[],hostOpportunity:true,latestHost:{id:index+1,text:item.text,final:true,endedAt:start},hostSpeaking:false,active:false,eligibleViewers:[],viewerWindow:false,proactiveCooldownMs:0,pendingOpportunity:false,programOpportunity:false},
        {information,signal:controller.signal,apiKey:process.env.DEEPSEEK_API_KEY,model:report.model})
      row.firstDecisionMs=Date.now()-start;row.decision={action:result.action,reason:result.reason,text:result.text}
      if(result.replyStream)for await(const record of result.replyStream)row.records.push(record)
      row.tools=owner.status(String(index)).recent
      row.pass=item.expected.every(name=>row.tools.some(tool=>tool.tool===name && tool.state==='completed')) && (item.expected.length>0 || row.tools.length===0)
    } catch(error) {row.error=error.code??error.name;row.tools=owner.status(String(index)).recent;row.pass=false}
    finally {clearTimeout(timer);result?.replyStream?.close();await information.close();row.totalMs=Date.now()-start;writeFileSync(output,JSON.stringify(report,null,2))}
    console.log(JSON.stringify({name:row.name,pass:row.pass,firstDecisionMs:row.firstDecisionMs,tools:row.tools.map(({tool,state,durationMs})=>({tool,state,durationMs})),error:row.error}))
  }
} finally {owner.close()}
report.passed=rows.filter(row=>row.pass).length;report.total=rows.length;writeFileSync(output,JSON.stringify(report,null,2))
console.log(JSON.stringify({output,passed:report.passed,total:report.total}))
if(report.passed!==report.total)process.exitCode=1
