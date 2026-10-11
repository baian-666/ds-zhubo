import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const data = fileURLToPath(new URL('../data/',import.meta.url))
const key = process.env.SILICONFLOW_API_KEY
if (!key) { console.error('未找到本机语音密钥，请先完成配置。'); process.exit(1) }
mkdirSync(data,{recursive:true})
const report = {
  kind:'Synthetic Chinese WAV tested with real cloud ASR; one short real TTS; no microphone capture',
  sourceText:'今天我们聊一聊直播间。小鲸鱼，你觉得这个故事怎么样？',
  generatedText:'你好，我是小鲸鱼。我们可以开始试播啦。',
  asr:{model:'FunAudioLLM/SenseVoiceSmall'},
  tts:{model:'FunAudioLLM/CosyVoice2-0.5B',voice:'claire'},
  calls:0
}
async function send(path,body,headers={}) {
  report.calls++
  const start=performance.now()
  const response=await fetch('https://api.siliconflow.cn/v1/'+path,{
    method:'POST',headers:{Authorization:'Bearer '+key,...headers},body,signal:AbortSignal.timeout(30000)})
  return {response,start,headersMs:Math.round(performance.now()-start)}
}
function duration(wav) {
  let rate=0,size=0
  for(let offset=12;offset+8<=wav.length;) {
    const id=wav.toString('ascii',offset,offset+4),length=wav.readUInt32LE(offset+4)
    if(id==='fmt '&&length>=16&&offset+24<=wav.length)rate=wav.readUInt32LE(offset+16)
    if(id==='data')size=Math.min(length,wav.length-offset-8)
    offset+=8+length+(length%2)
  }
  return rate>0 ? Math.round(size/rate*1000)/1000 : null
}
try {
  const form=new FormData()
  form.set('model',report.asr.model)
  form.set('file',new Blob([readFileSync(new URL('../data/voice-fixture.wav',import.meta.url))],{type:'audio/wav'}),'synthetic-chinese.wav')
  try {
    const {response,start}=await send('audio/transcriptions',form)
    report.asr.httpStatus=response.status
    if(response.ok) {
      const result=await response.json()
      report.asr.text=typeof result.text==='string'?result.text.replaceAll(key,'[已隐藏]').slice(0,2000):''
      report.asr.pass=Boolean(report.asr.text)
    } else {await response.body?.cancel();report.asr.pass=false}
    report.asr.totalMs=Math.round(performance.now()-start)
  }catch{report.asr.pass=false;report.asr.error='network-or-timeout'}
  console.log(JSON.stringify({asr:report.asr}))
  try {
    const {response,start,headersMs}=await send('audio/speech',JSON.stringify({
      model:report.tts.model,input:report.generatedText,voice:report.tts.model+':'+report.tts.voice,response_format:'wav',sample_rate:24000,stream:false
    }),{'Content-Type':'application/json'})
    report.tts.httpStatus=response.status;report.tts.headersMs=headersMs
    if(response.ok) {
      const wav=Buffer.from(await response.arrayBuffer())
      report.tts.pass=wav.length>44&&wav.toString('ascii',0,4)==='RIFF'&&wav.toString('ascii',8,12)==='WAVE'
      if(report.tts.pass) {
        writeFileSync(new URL('../data/siliconflow-voice-trial.wav',import.meta.url),wav)
        report.tts.bytes=wav.length;report.tts.seconds=duration(wav)
        report.tts.audioPath=fileURLToPath(new URL('../data/siliconflow-voice-trial.wav',import.meta.url))
      }
    }else {await response.body?.cancel();report.tts.pass=false}
    report.tts.totalMs=Math.round(performance.now()-start)
  }catch{report.tts.pass=false;report.tts.error='network-or-timeout'}
}finally{
  report.pass=Boolean(report.asr.pass&&report.tts.pass)
  writeFileSync(new URL('../data/siliconflow-voice-trial.json',import.meta.url),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
}
if(!report.pass)process.exitCode=1
