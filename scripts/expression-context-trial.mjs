import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { whaleCapabilities } from '../integrations/airi/whale-capabilities.ts'
import { streamParticipation, streamingParticipationRequest } from '../apps/cohost/participation-stream.mjs'
import { defaultPersona } from '../apps/cohost/runtime-profile.mjs'
import { constrainPerformance } from '../packages/cohost-contracts/performance.ts'
import { performanceTarget } from '../packages/cohost-contracts/performance.ts'
import { Performance } from '../apps/cohost/performance.mjs'

// Synthetic natural chat, real provider, production parser and capability gate.
// Never send production history or write to the running session; no TTS/ASR.
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8) || 'candidate'
if(!/^[a-z0-9-]+$/.test(label))throw Error('Invalid label')
if(!process.env.DEEPSEEK_API_KEY)throw Error('Missing local credential')
const rig=JSON.parse(readFileSync('data/omelet-rig-before.json','utf8'))
const capabilities=whaleCapabilities({...rig,expressionGroups:new Map(rig.groups),expressions:new Map(rig.entries),isExposedToLlm:name=>rig.exposed.includes(name)},true,'live2d')
const db=new DatabaseSync('data/cohost-session.sqlite',{readOnly:true})
const model=JSON.parse(db.prepare("select payload from module_settings where id='inference'").get().payload).value.model
db.close()
const profile={prompt:defaultPersona,capabilities}
const holdout=process.argv.includes('--holdout')
const movement=process.argv.includes('--movement')
const sessions=movement?[
  {name:'自然观点',turns:['我觉得旅游不用把每一分钟都排满，留点空白反而容易碰到有意思的事，你呢？','不过要是完全不做准备，到地方才发现今天闭馆，那也挺尴尬的。','那就记一个重点：开放时间提前看，其他留点余地。']},
  {name:'好奇与克制',turns:['假如书里的人物会在你翻页时跟你打招呼，你会先问他们什么？','我觉得他们会问你：怎么这么久才翻到我这一页。','先别接，我把这个故事讲完。']},
  {name:'明确摇尾',turns:['小鲸鱼，动动尾巴给我看看。','动作有点小，再明显一点，左右摇一下。','好啦收起来，我们接着聊。']},
]:holdout?[
  {name:'平淡纠正',turns:['我们明天八点开播，今晚把提纲理好。','刚才时间说错了，是八点半，不是八点。','好，就按八点半记着。']},
  {name:'小心意',turns:['我给你想了个专属称号：全宇宙最靠谱的聊天搭子。','真的，有你陪着，这个晚上没那么难熬了。','嗯，接下来聊点轻松的吧。']},
  {name:'新发现',turns:['我构思了一座不用睡觉的水下游乐园，鲸鱼可以坐泡泡过山车，门票是一段冷笑话。你想先玩什么？','冷笑话必须把评委逗笑，评委是一块石头。','不用过评委了，那是入口的装饰石头。']},
  {name:'反转和词义',turns:['我吹牛说我很会认路，结果带全队绕了一小时，回到了出发的奶茶店。','我在写词语卡片：害羞、难过、惊讶这三个词，帮我按汉字数分类就行。','我先把剩下的卡片念完，你先听着，不用回答。']},
]:[
  {name:'日常安排',turns:['今晚先聊做饭，再聊电影，顺序就这样。','我刚才说的电影是动画电影，不是真人电影。','那先帮我把这两个话题列一下就行。']},
  {name:'夸奖与接梗',turns:['刚才你接住那个冷笑话，真挺机灵的，和你聊天越来越有意思了。','我夸的是你呀，别推给服务器。','好啦，咱们接着聊。']},
  {name:'期待与落空',turns:['要是能给你办个海底图书馆，每一本书都能变成会游泳的小故事，你最想先翻哪本？','不过入馆条件是先做完一千道高数题，还得全对。','开玩笑的，入馆免费。你慢慢挑，我先把书架摆好。']},
  {name:'尴尬与认真',turns:['我把给猫看的视频投到会议大屏上了，还一本正经说这是本季度重点项目。','笑完说正事，我最近准备了很久的比赛没过，确实挺失落的。','谢谢，我先把经过说完，后面还有一段，你先听着。']},
]
const directory=resolve('data/expression-context-'+label+'-'+Date.now())
mkdirSync(directory,{recursive:true})
const results=[]
const report={method:'Synthetic multi-turn chat; real DeepSeek; default persona; frozen local rig with exposed expressions; no production history, TTS, microphone or live playback. No automatic retries. Movement suite includes two explicit tail requests.',holdout,movement,model,capabilities,results}
writeFileSync(resolve(directory,'prompt.txt'),streamingParticipationRequest({}, {model,profile}).messages[0].content)
report.promptHash=createHash('sha256').update(readFileSync(resolve(directory,'prompt.txt'))).digest('hex')
for(const session of sessions){
  const history=[],scene=[]
  const performanceHistory=new Performance(),scope='isolated-trial',target=performanceTarget(capabilities)
  for(const [index,text] of session.turns.entries()){
    scene.push({role:'host',text,topic:1})
    const snapshot={history:[...history],scene:[...scene],recentPerformancePlans:performanceHistory.recentPlans(scope,target),currentTopic:1,hostOpportunity:true,latestHost:{id:index+1,text,final:true,endedAt:Date.now()},hostSpeaking:false,active:false,viewerWindow:false,eligibleViewers:[],proactiveCooldownMs:0,programOpportunity:false,pendingOpportunity:false,stickers:[]}
    const row={session:session.name,index,text},start=Date.now()
    results.push(row)
    let response,rawResponse
    try{
      response=await streamParticipation(snapshot,{apiKey:process.env.DEEPSEEK_API_KEY,model,profile,timeoutMs:30000,fetchImpl:async (...args)=>{
        const upstream=await fetch(...args)
        if(upstream.ok)rawResponse=upstream.clone().text().catch(()=>null)
        return upstream
      }})
      row.firstDecisionMs=Date.now()-start
      const {replyStream,...decision}=response
      row.decision=decision;row.records=[]
      if(replyStream)for await(const record of replyStream)row.records.push(record)
      row.answer=replyStream?row.records.filter(r=>r.kind==='speech').map(r=>r.text).join(''):decision.text
      row.filtered=constrainPerformance(row.records.find(r=>r.kind==='presentation')??decision,capabilities)
      if(!['wait','stop'].includes(decision.action))performanceHistory.play(row.filtered.performance,{scope,target,turn:index+1,motion:row.filtered.motion})
      row.expressions=[...new Set(row.filtered.motion?.frames.flatMap(f=>f.expression&&f.expression.strength>0?[f.expression.name]:[])??[])]
      const alias=capabilities.aliases.find(a=>a.name===row.filtered.performance)
      if(!row.filtered.motion&&alias)row.expressions.push(alias.expression)
      history.push({role:'user',content:JSON.stringify({source:'host',text})})
      if(row.answer)history.push({role:'assistant',content:row.answer})
    }catch(error){row.error=error.code??error.name}
    finally{response?.replyStream?.close()}
    const raw=await rawResponse
    if(raw)writeFileSync(resolve(directory,`response-${results.length}.sse`),raw)
    row.totalMs=Date.now()-start
    writeFileSync(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({session:row.session,index,answer:row.answer,action:row.decision?.action,expressions:row.expressions,...(movement?{performance:row.filtered?.performance,motion:row.filtered?.motion}:{}),issues:row.filtered?.issues,error:row.error}))
  }
}
report.summary={total:results.length,errors:results.filter(r=>r.error).length,expressiveTurns:results.filter(r=>r.expressions?.length).length,expressions:[...new Set(results.flatMap(r=>r.expressions??[]))],invalid:results.filter(r=>r.filtered?.issues.length||r.decision?.warnings.length||r.records?.some(p=>p.warnings?.length)).length}
writeFileSync(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({directory,...report.summary}))
if(report.summary.errors||report.summary.invalid)process.exitCode=1
