import assert from 'node:assert/strict'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {writeFileSync} from 'node:fs'
import {createApp} from '../apps/cohost/server.mjs'
import {planParticipation} from '../apps/cohost/participation-model.mjs'
import {streamReply} from '../apps/cohost/deepseek.mjs'

// Invented conversations on a separate backend; never read or replay the user's room.
const real=process.argv.includes('--real')
if(real&&!process.env.DEEPSEEK_API_KEY)throw Error('Configure the local model credential first')
const steps=[
 {text:'今天先讲一件离谱的事。我家的猫叫年糕，昨晚我终于下定决心打开跑步机，结果它先跳上去睡觉了。我本来想把它抱下来，可它翻了个身把肚子露出来，一副这台机器就是它买的样子。先别替我下结论，我还有后半段，想吐槽的话先记着，等我讲完再说。',mock:{action:'wait',reason:'后半段还没讲完，我先记着猫占跑步机这件事。',thought:{text:'讲完后接回年糕才是跑步机房东的梗。',wake:'next_host_turn'}}},
 {text:'后半段更搞笑。我怕吵醒它，最后自己去楼下散步了半小时，回来发现年糕睡醒了，它盯着我，好像还嫌我出去没带零食。我明明买机器是给自己锻炼，最后变成我给它付房租。好了我讲完了，你是不是也觉得这房东有点过分？',mock:{action:'reply_host',hostIntent:'invited',reason:'主播讲完了，现在可以接回刚才的房东梗。',text:'你负责交房租，年糕负责保持睡眠质量。'}},
 {viewer:'哈哈，年糕收的房租是不是猫条？',userId:'团子',mentioned:false},
 {text:'对了，刚才叫你大肥鱼不是嫌弃你，我就是觉得你的尾巴很适合这个跑步机直播间。可是如果我下次跑两分钟就想坐下，你会夸我努力了，还是会拿年糕来嘲笑我？你可以嘴硬一点，但别给我开一个十条建议的健身计划。',mock:{action:'reply_host',hostIntent:'invited',reason:'主播直接邀请我调侃，短句接住就够了。',text:'年糕至少坚持躺了两小时，你才两分钟。'}},
 {text:'嗯，对',mock:{action:'wait',reason:'这是附和，不必再接一句。'}},
 {topic:true},
 {text:'换个话题，我今天做了蛋包饭。第一次把蛋煎成了一张地图，第二次总算完整了，结果挤番茄酱的时候手一抖，画出一条歪歪扭扭的鱼。我现在想给这盘饭起个名字，但别把我刚才的跑步机故事当成新发生的事。你帮我取个短一点的名字吧。',mock:{action:'reply_host',hostIntent:'invited',reason:'这是新话题，给这盘饭取一个短名字。',text:'大肥鱼登陆失败。'}},
 {text:'再回想一下，刚才那只占跑步机的猫叫什么？我为了不吵醒它最后去哪里运动了？另外你还记得我点外卖花了多少钱吗？如果我没有说过金额就直接告诉我没说，不要为了接梗替我编一个价格。',mock:{action:'reply_host',hostIntent:'invited',reason:'只回忆有记录的名字和地点，金额没有记录。',text:'年糕。你去楼下散步了，外卖金额没说过。'}},
]
let planCalls=0,replyCalls=0,currentStep,contexts=[]
const server=createApp({apiKey:real?process.env.DEEPSEEK_API_KEY:'test-only',token:'',semanticEnabled:true,rehearsal:true,
 participationOptions:{debounceMs:10},
 planner:async(snapshot,options)=>{
  planCalls++;contexts.push({topic:snapshot.currentTopic,hasNote:!!snapshot.pendingThought,hasCat:snapshot.scene.some(entry=>entry.text.includes('年糕'))})
  return real?planParticipation(snapshot,{...options,apiKey:process.env.DEEPSEEK_API_KEY,model:process.env.DEEPSEEK_MODEL||'deepseek-flash'}):
   {hostIntent:'none',text:'',targetId:'',platform:'',performance:'idle',...currentStep.mock}
 },reply:async function*(args){replyCalls++;if(real)yield* streamReply(args);else yield '模拟直接回答。'},
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port,rows=[]
const post=async(path,body)=>{
 const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
 if(!response.ok)throw Error('Trial route failed: '+path+' HTTP '+response.status)
 return response
}
const status=()=>fetch(base+'/api/status').then(r=>r.json())
let utterance=0
try {
 for(const step of steps){
  currentStep=step
  if(step.topic){await post('director/event',{type:'topic-change'});rows.push({topicChanged:true});continue}
  if(step.viewer){await post('danmaku',{id:'viewer-'+rows.length,platform:'manual',userId:step.userId,text:step.viewer,mentioned:step.mentioned});rows.push({viewer:step.viewer});continue}
  const started=Date.now(),id=++utterance
  for(const event of [{type:'speech-start'},{type:'transcript',text:step.text,final:true},{type:'speech-end'}])await post('director/event',{...event,utterance:id})
  let state
  for(let n=0;n<120;n++){
   await delay(50);state=await status()
   if(state.director.candidate || (!state.participation.busy && state.director.trace.some(entry=>['participation_wait','participation_reaction','participation_error','participation_timeout','short_acknowledgment'].includes(entry.reason) && entry.at>=started)))break
  }
  const row={host:step.text,reason:state.director.lastDecision?.reason,explanation:state.director.lastDecision?.explanation,note:state.participation.pendingThought?.text??null,elapsedMs:Date.now()-started,answer:null}
  if(state.director.candidate){
   const response=await post('reply',{source:'director',decision:state.director.candidate.id,engine:'deepseek'})
   const events=(await response.text()).trim().split('\n').map(JSON.parse)
   row.answer=events.filter(event=>event.type==='delta').map(event=>event.text).join('')
   row.status=events.at(-1).entry?.status
  }
  rows.push(row);console.log(JSON.stringify({step:rows.length,reason:row.reason,note:!!row.note,answered:!!row.answer,elapsedMs:row.elapsedMs}))
 }
 const before=planCalls;await delay(1300);assert.equal(planCalls,before,'Quiet next-turn notes and ordinary waits must not poll')
 if(!real){assert.ok(rows[0].note);assert.ok(contexts[1].hasNote);assert.ok(rows.at(-1).answer.includes('没说过'));assert.equal(replyCalls,0)}
 const result={kind:real?'real DeepSeek with invented long dialogue; not human voice':'mock intentions + long-dialogue scheduling',planCalls,replyCalls,contexts,rows}
 writeFileSync(real?'data/continuity-real-result.json':'data/continuity-mock-result.json',JSON.stringify(result,null,2))
 console.log(JSON.stringify({kind:result.kind,planCalls,replyCalls,steps:rows.length,quietPolling:false}))
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
