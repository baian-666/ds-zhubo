import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chunkTtsInput } from '../vendor/airi/packages/pipelines-audio/dist/index.mjs'
import { streamQwenAudio } from './qwen-audio-client.mjs'
import { createQwenSessionCache } from './qwen-realtime-client.mjs'
import { loadQwenClone } from '../apps/cohost/qwen-clone.mjs'

// Isolated listening comparison. No production configuration, playback or chat writes.
const directory = resolve(process.argv[2] ?? 'data/voice-consistency-20261018/run-01')
if (existsSync(directory)) throw Error('Output already exists. Preserve previous samples.')
const headers = process.env.COHOST_ACCESS_TOKEN ? { Authorization: 'Bearer ' + process.env.COHOST_ACCESS_TOKEN } : {}
async function status() {
  const response = await fetch('http://127.0.0.1:8787/api/status', { headers })
  if (!response.ok) throw Error('Cannot inspect the production session')
  return response.json()
}
const before = await status()
if (before.active || before.hostSpeaking || before.participation?.busy || ['running','observing'].includes(before.hosting?.state))
  throw Error('Wait for the production conversation to become idle')
const original = before.room.entries.find(entry => entry.role === 'assistant' && entry.text.startsWith('行，这个场景我不用演'))
if (!original || original.speechStyle !== 'happy' || before.configuration.speechBackend !== 'qwen')
  throw Error('Cannot verify the reported utterance and Qwen configuration')
const clone = loadQwenClone()
const hash = value => createHash('sha256').update(value).digest('hex')
const fingerprints = () => Object.fromEntries(['.env','data/qwen/voice.json'].map(path => [path,hash(readFileSync(path))]))
const savedFingerprints = fingerprints()
const segments = []
for await (const segment of chunkTtsInput(original.text, {preserveSourceText:true,boost:0,maximumWords:24})) segments.push(segment.text)
if (segments.join('') !== original.text) throw Error('Segment reconstruction changed the source text')
mkdirSync(directory, {recursive:true})
const report = { kind:'isolated-real-Qwen-listening-comparison', original:{turn:original.turn,text:original.text,speechStyle:original.speechStyle,speechRevision:original.speechRevision},
  limitation:'New synthesis, not a recording of the incident. Original model speech-record boundaries were not retained. Boundaries reconstructed by the current chunker. Concatenated baseline excludes network playback gaps. No listening verdict or latency comparison.',
  model:clone.model,voiceHash:hash(clone.voice),segments,trials:[],beforeFingerprints:savedFingerprints }
function save() {writeFileSync(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n')}
function wav(pcm) {
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8)
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24)
  header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40)
  return Buffer.concat([header,pcm])
}
function inspect(pcm) {
  if (!pcm.length || pcm.length%2) throw Error('Empty or invalid PCM')
  let peak=0,sum=0,clipped=0
  for(let offset=0;offset<pcm.length;offset+=2) {const sample=pcm.readInt16LE(offset);peak=Math.max(peak,Math.abs(sample));sum+=sample*sample;if(sample===32767||sample===-32768)clipped++}
  const result={sampleRate:24000,channels:1,duration:pcm.length/48000,peak:peak/32768,rms:Math.sqrt(sum/(pcm.length/2))/32768,clipped,finite:true}
  if(result.rms<0.0001 || clipped)throw Error('Silence or clipping detected')
  return result
}
for (const mode of ['segmented','continuous']) {
  const live=await status()
  if(live.active || live.hostSpeaking || live.participation?.busy) throw Error('Production conversation resumed; stop the isolated trial')
  const trial={mode,requests:[],files:[]};report.trials.push(trial);save()
  const cache=createQwenSessionCache({maxIdle:2})
  // Only the experimental transport changes: one task accepts sequential text chunks.
  class Transport {
    constructor(...args) {
      const socket=new WebSocket(...args),send=socket.send.bind(socket)
      let tail=Promise.resolve()
      socket.send=value=>{
        const event=JSON.parse(value),action=event.header.action
        if(action==='run-task')trial.requests.push({taskId:event.header.task_id,model:event.payload.model,voiceHash:hash(event.payload.parameters.voice),instruction:event.payload.parameters.instruction,rate:event.payload.parameters.rate,pitch:event.payload.parameters.pitch,texts:[]})
        const current=trial.requests.find(item=>item.taskId===event.header.task_id)
        if(action==='continue-task' && mode==='continuous') {
          tail=(async()=>{for(const [index,text] of segments.entries()) {
            if(index)await new Promise(resolve=>setTimeout(resolve,120))
            if(socket.readyState!==1)return
            current.texts.push(text);send(JSON.stringify({...event,payload:{input:{text}}}))
          }})()
        } else if(action==='finish-task' && mode==='continuous')void tail.then(()=>{if(socket.readyState===1)send(value)})
        else {if(action==='continue-task')current.texts.push(event.payload.input.text);send(value)}
      }
      return socket
    }
  }
  const pcmParts=[]
  try {
    // Two independent tasks in flight reproduce the production concurrency limit.
    const inputs=mode==='segmented'?segments:[original.text]
    for(let offset=0;offset<inputs.length;offset+=2) {
      const batch=await Promise.all(inputs.slice(offset,offset+2).map(async(text,index)=>{
        const frames=[]
        const result=await streamQwenAudio({key:process.env.DASHSCOPE_API_KEY,...clone,text,speechStyle:'happy',sessionCache:cache,WebSocketImpl:Transport,
          onEvent:event=>{if(event.type==='audio')frames.push(Buffer.from(event.pcm,'base64'))}})
        const pcm=Buffer.concat(frames),stats=inspect(pcm),name=`${mode}-${String(offset+index+1).padStart(2,'0')}.wav`
        writeFileSync(resolve(directory,name),wav(pcm));trial.files.push({name,text,...stats,providerChunks:result.chunks});save()
        return pcm
      }))
      pcmParts.push(...batch)
    }
    const pcm=Buffer.concat(pcmParts);trial.combined={name:mode+'.wav',...inspect(pcm),sha256:hash(pcm)}
    writeFileSync(resolve(directory,trial.combined.name),wav(pcm));trial.success=true
  } catch(error) {trial.error='Cloud trial failed. Partial evidence retained; do not treat as complete.';trial.safeClientError=error.message;process.exitCode=1}
  finally {cache.clear();save()}
  console.log(JSON.stringify({mode,success:trial.success,requests:trial.requests.length,audio:trial.combined,error:trial.error}))
  if(!trial.success)break
}
report.afterFingerprints=fingerprints()
report.configurationFilesUnchanged=JSON.stringify(savedFingerprints)===JSON.stringify(report.afterFingerprints)
const after=await status();report.speechRevisionUnchanged=before.configuration.speechRevision===after.configuration.speechRevision
save()
if(!report.configurationFilesUnchanged || !report.speechRevisionUnchanged)throw Error('Concurrent voice configuration change detected')
console.log('Evidence: '+directory)
