// Real local speech + cohost HTTP. ASR, LLM text and playback receipts are simulated.
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createApp } from '../apps/cohost/server.mjs'

const engine=process.argv.includes('--index')?'index':'aqua'
const textOnly=process.argv.includes('--text-only')

const server=createApp({apiKey:'fixture-only',token:'',rehearsal:true,
  speechOptions:{engine},airiOptions:{key:'fixture-only'},
  reply:async function*(){yield '我在听，你继续。'}})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
let report
try {
  const stage={stage:'web',owner:'aqua-smoke-stage',ready:true,listening:!textOnly}
  const pulse=()=>post('/api/airi/stage/pulse',stage,{Origin:'http://127.0.0.1:5173'})
  await pulse()
  const started=await post('/api/airi/start',{stage:'web',owner:'aqua-smoke-console',capture:!textOnly})
  if(!started.ok)throw Error('Stage lease preparation failed')
  const lease=await(await pulse()).json()
  const headers={Origin:'http://127.0.0.1:5173',Authorization:'Bearer '+lease.run+':aqua-smoke-stage'}
  const event=body=>post('/api/airi/stage/event',body,headers)
  const timer=setInterval(()=>void pulse(),300)
  try {
    const input=textOnly?body=>post('/api/director/event',body):event
    await input({type:'speech-start',utterance:1})
    await input({type:'transcript',utterance:1,text:'小鲸鱼，你觉得今天怎么样？',final:true})
    await input({type:'speech-end',utterance:1})
    let turn
    const deadline=Date.now()+5000
    while(Date.now()<deadline){const status=await(await pulse()).json();if(status.turn?.done){turn=status.turn;break}await new Promise(resolve=>setTimeout(resolve,30))}
    if(!turn)throw Error('No fixture reply')
    const beginning=performance.now()
    const response=await post('/api/airi/stage/audio/speech',{turn:turn.id,input:turn.text},headers)
    if(!response.ok)throw Error('Speech route failed')
    const reader=response.body.getReader(),decoder=new TextDecoder()
    let buffer='',first=null,done=false,bytes=0,chunks=0,providerFirst=null
    while(true){const frame=await reader.read();if(frame.done)break;buffer+=decoder.decode(frame.value,{stream:true});let end
      while((end=buffer.indexOf('\n'))>=0){const data=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1)
        if(data.type==='error')throw Error('Speech stream failed')
        if(data.type==='audio'){if(data.sampleRate!==(engine==='index'?22050:24000))throw Error('Wrong sample rate');first??=performance.now()-beginning;bytes+=Buffer.from(data.pcm,'base64').length;chunks++}
        if(data.type==='done'){done=true;providerFirst=data.firstPcmMs}
      }
    }
    if(!done||!bytes||!chunks)throw Error('No complete PCM')
    const completeMs=performance.now()-beginning
    const played={type:'playback',turn:turn.id,audioId:turn.audioId}
    if(!(await(await event({...played,event:'started',playedChars:0})).json()).accepted)throw Error('Playback receipt rejected')
    if(!(await(await event({...played,event:'ended',playedChars:turn.text.length})).json()).accepted)throw Error('Completion receipt rejected')
    report={engine,textOnly,kind:'Real local speech and production cohost speech route; simulated ASR/LLM/playback receipts; no physical speaker timing',
      firstPcmMs:first,providerFirstPcmMs:providerFirst,completeMs,chunks,pcmBytes:bytes,sentence:turn.text,completionAccepted:true}
    writeFileSync(new URL('../data/'+(engine==='index'?'indextts':'aqua-tts')+'/live-smoke-'+Date.now()+'.json',import.meta.url),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify(report))
  } finally {clearInterval(timer)}
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
