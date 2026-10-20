import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { planParticipation } from '../apps/cohost/participation-model.mjs'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'
import { SpeechOutput } from '../apps/cohost/speech-output.mjs'
import { nativeExpressions } from '../integrations/airi/whale-rig.ts'
import { chunkTtsInput } from '../vendor/airi/packages/pipelines-audio/dist/index.mjs'

// Real, paid DeepSeek requests and the existing local Index worker. No settings are saved.
// Measure provider request to first PCM receipt, not microphone or physical speaker latency.
const count=Number(process.argv.find(x=>x.startsWith('--pairs='))?.slice(8) ?? 3)
if (!Number.isInteger(count) || count<1 || count>30) throw Error('Use --pairs=1..30')
const root=new URL('../',import.meta.url)
const env=parseEnv(readFileSync(new URL('.env',root),'utf8'))
if(!env.DEEPSEEK_API_KEY)throw Error('DeepSeek is not configured')
const speech=new SpeechOutput({engine:'index',voice:'local-reference',startLocal:()=>{throw Error('Start the shared Index worker before benchmarking')}})
const prompts=[
  '你说猫把跑步机当成猫窝，是不是一种很新的健身方式？顺便笑一下。',
  '刚刚有人说我打游戏像在给对面送外卖，你帮我想一句有趣的回应吧。',
  '如果直播间突然停电了，你会怎样救场？回答两句，顺便摇摇尾巴。',
]
const folder=new URL('data/first-voice-benchmark/',root)
mkdirSync(folder,{recursive:true})
const result={measurement:'real DeepSeek request to first local Index PCM receipt; excludes input/ASR, browser and speaker',startedAt:new Date().toISOString(),model:env.DEEPSEEK_MODEL||'deepseek-flash',pairs:count,voice:'unchanged running Index worker',samples:[]}
const save=()=>writeFileSync(new URL('results.json',folder),JSON.stringify(result,null,2))
const quantile=(values,p)=>{const sorted=values.toSorted((a,b)=>a-b);return sorted.length?sorted[Math.ceil(p*sorted.length)-1]:null}
async function idleWorker() {
  const until=Date.now()+45000
  while(Date.now()<until) {
    const health=await fetch('http://127.0.0.1:8794/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json())
    result.index={engine:health.engine,beams:health.beams,cfmSteps:health.cfmSteps,reference:health.reference,output:health.output}
    if(!health.busy)return
    await new Promise(resolve=>setTimeout(resolve,200))
  }
  throw Error('Shared Index worker is busy. Try the benchmark later.')
}
await speech.prepare()
try {
  // Warm the same reference and kernels without changing the worker or its preset.
  await idleWorker()
  await speech.stream('今天我们一起聊点有趣的事情。',{emit:()=>{}})
  for(let pair=0;pair<count;pair++) {
    const text=prompts[pair%prompts.length]
    const snapshot={scene:[{role:'host',text,topic:1}],history:[],currentTopic:1,hostOpportunity:true,latestHost:{id:1,text,final:true,endedAt:Date.now()},proactiveCooldownMs:0,viewerWindow:false,active:false,hostSpeaking:false,eligibleViewers:[],pendingThought:null,pendingOpportunity:false,stickers:[]}
    for(const mode of pair%2?['stream','buffered']:['buffered','stream']) {
      await idleWorker()
      const controller=new AbortController(),at=performance.now()
      const sample={pair,scenario:pair%prompts.length,mode}
      let stream,pcm=[],rate=22050,timeout=setTimeout(()=>controller.abort(),4500)
      try {
        const answer=await (mode==='stream'?streamParticipation:planParticipation)(snapshot,{apiKey:env.DEEPSEEK_API_KEY,model:result.model,profile:{expressions:nativeExpressions,components:true},signal:controller.signal})
        clearTimeout(timeout)
        sample.decisionMs=Math.round(performance.now()-at)
        sample.action=answer.action;sample.firstRecord=answer.text
        stream=answer.replyStream
        let text=answer.text
        if(!answer.action.startsWith('reply_'))throw Error('No spoken response')
        // The renderer uses this exact segmenter. First validated record carries an explicit flush.
        for await(const chunk of chunkTtsInput(text,{preserveSourceText:true})){text=chunk.text;break}
        sample.spokenPrefix=text
        sample.ttsStartMs=Math.round(performance.now()-at)
        const generation=(async()=>{
          sample.records=[]
          if(stream)for await(const record of stream)sample.records.push(record)
          sample.generationMs=Math.round(performance.now()-at)
        })()
        const audio=speech.stream(text,{signal:controller.signal,emit:event=>{
          if(event.type==='audio') {
            sample.firstPcmMs??=Math.round(performance.now()-at)
            rate=event.sampleRate
            if(pair===0)pcm.push(Buffer.from(event.pcm,'base64'))
          }
        }})
        await Promise.all([generation,audio])
        sample.completeMs=Math.round(performance.now()-at)
        sample.ttsFirstPcmMs=sample.firstPcmMs-sample.ttsStartMs
        if(pcm.length) {
          const audio=Buffer.concat(pcm),header=Buffer.alloc(44)
          header.write('RIFF');header.writeUInt32LE(audio.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(audio.length,40)
          writeFileSync(new URL(mode+'-first-prefix.wav',folder),Buffer.concat([header,audio]))
        }
      }catch(error){sample.error=error.code||error.name;controller.abort()}
      finally{clearTimeout(timeout);stream?.close()}
      result.samples.push(sample);save()
      console.log(JSON.stringify({pair,mode,decisionMs:sample.decisionMs,firstPcmMs:sample.firstPcmMs,error:sample.error}))
    }
  }
  result.summary=Object.fromEntries(['buffered','stream'].map(mode=>{
    const rows=result.samples.filter(x=>x.mode===mode),ok=rows.filter(x=>!x.error&&x.firstPcmMs)
    return [mode,{samples:rows.length,failures:rows.length-ok.length,decisionP50:quantile(ok.map(x=>x.decisionMs),.5),decisionP95:quantile(ok.map(x=>x.decisionMs),.95),firstPcmP50:quantile(ok.map(x=>x.firstPcmMs),.5),firstPcmP95:quantile(ok.map(x=>x.firstPcmMs),.95)}]
  }))
  result.completedAt=new Date().toISOString();save();console.log(JSON.stringify(result.summary))
} finally {speech.close()}
