import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../apps/cohost/server.mjs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'
import { streamReply } from '../apps/cohost/deepseek.mjs'
import { planParticipation } from '../apps/cohost/participation-model.mjs'

const real = process.argv.includes('--real')
const semantic = process.argv.includes('--semantic')
if (semantic && !real) throw new Error('--semantic requires --real')
const plans = []
const keepOpen = process.argv.includes('--serve')
if (real && !process.env.DEEPSEEK_API_KEY) throw new Error('真实试验需要本机 .env 中的 DEEPSEEK_API_KEY')
const steps = JSON.parse(readFileSync(new URL('../tests/fixtures/director-conversation.json', import.meta.url), 'utf8'))
const modelInputs = []
async function* observedReply(args) {
  // Record only the public conversation handed to the model, never credentials or headers.
  modelInputs.push({ input: args.input, history: args.history, scene:args.scene, sawCatName: JSON.stringify([args.input, ...args.history, ...args.scene]).includes('年糕') })
  yield* streamReply(args)
}
const server = createApp({ apiKey: real ? process.env.DEEPSEEK_API_KEY : '', token: '', reply: observedReply, semanticEnabled:semantic, planner:semantic ? async (snapshot,options) => {
  const started=Date.now()
  try { const result=await planParticipation(snapshot,{...options,apiKey:process.env.DEEPSEEK_API_KEY,model:process.env.DEEPSEEK_MODEL || 'deepseek-flash'});plans.push({result,elapsed:Date.now()-started});return result }
  catch(error){plans.push({failed:true,elapsed:Date.now()-started});throw error}
} : undefined })
server.listen(keepOpen ? (semantic ? 8789 : 8788) : 0, '127.0.0.1')
await once(server, 'listening')
const base = 'http://127.0.0.1:' + server.address().port
const rows = []
let utterance = 0
async function post(path, body) {
  const response = await fetch(base + '/api/' + path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
  if (!response.ok) throw new Error('试验接口失败：' + path + ' HTTP ' + response.status)
  return response
}
async function state() { return (await fetch(base + '/api/status')).json() }
async function host(text) {
  const id = ++utterance
  await post('director/event', {type:'speech-start',utterance:id})
  await delay(120)
  await post('director/event', {type:'transcript',utterance:id,text,final:true})
  return (await post('director/event', {type:'speech-end',utterance:id})).json()
}
function stopProbe(text) {
  let now = 1000
  const scheduler = new Scheduler({now:()=>now}), director = new Director({scheduler,now:()=>now})
  director.event({type:'mode',value:'auto'})
  scheduler.beginHost('用于检查打断判定的在途占位话轮')
  director.event({type:'speech-start',utterance:1})
  now += 300
  director.event({type:'transcript',utterance:1,text,final:true})
  director.event({type:'speech-end',utterance:1})
  const result = {text,intent:director.intent,stillBusy:scheduler.status().busy,reason:director.status().lastDecision?.reason}
  director.close()
  return result
}
try {
  await post('director/event',{type:'mode',value:'auto'})
  for (const step of steps) {
    if (step.kind === 'host') await host(step.text)
    if (step.kind === 'viewer') await post('danmaku',{...step,platform:'manual',selected:false})
    if (step.kind === 'window') await post('director/event',{type:'viewer-window',value:step.value})
    let before = await state()
    if(semantic && !before.director.candidate) {
      const deadline=Date.now()+5200
      do { await delay(100);before=await state() } while(Date.now()<deadline && before.participation.busy && !before.director.candidate)
    }
    const candidate = before.director.candidate
    const row = { ...step, candidate: candidate ? { source:candidate.source ?? 'host',text:candidate.text,intent:candidate.intent } : null,
      reason:before.director.lastDecision?.reason, explanation:before.director.lastDecision?.explanation, generated:false }
    if (candidate) {
      const response = await post('reply',{source:'director',decision:candidate.id,engine:real?'deepseek':'mock',delivery:'text'})
      const events = (await response.text()).trim().split('\n').map(JSON.parse)
      row.generated = events.some(x=>x.type==='done')
      row.answer = events.filter(x=>x.type==='delta').map(x=>x.text).join('')
      row.terminal = events.at(-1).type
      row.firstMs = events.at(-1).entry?.firstMs
      row.decisionMs = events.at(-1).entry?.decisionMs
    }
    if (step.pauseMs) {
      await delay(step.pauseMs)
      row.candidateAfterPause = Boolean((await state()).director.candidate)
    }
    rows.push(row)
  }
  const result = {
    real, semantic, plans, model:(await state()).model, url:base, rows, modelInputs,
    timingProbesSimulated:true,
    stopProbes:[stopProbe('嗯，对'),stopProbe('等一下，我还没说完，先让我补充一个细节。'),stopProbe('等一下')],
    room:(await state()).room
  }
  mkdirSync('data',{recursive:true})
  const resultPath=semantic ? 'data/director-semantic-result.json' : 'data/director-conversation-result.json'
  writeFileSync(resultPath,JSON.stringify(result,null,2))
  console.log(JSON.stringify({url:base,real,steps:rows.length,completedReplies:rows.filter(x=>x.generated).length,
    replySteps:rows.filter(x=>x.generated).map(x=>x.id),plannerCalls:plans.length, generationCalls:modelInputs.length,result:resultPath}))
  if (keepOpen) console.log('独立试验页面保留运行；8787 原场次未修改。')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve))
}
if (!keepOpen) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
