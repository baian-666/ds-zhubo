import { readFileSync, writeFileSync } from 'node:fs'

const label=process.argv[2]
if(!/^[a-z0-9-]+$/.test(label??''))throw Error('Provide a recorded trial label')
const prefix='data/listening-audio-trial/'+label
const trial=JSON.parse(readFileSync(prefix+'.json'))
const audio=JSON.parse(readFileSync(prefix+'-analysis.json'))
const relative=at=>Number.isFinite(at)?Math.round(at-audio.start):null
const transcript=trial.events.filter(event=>event.type==='transcript').at(-1)
const inputEnd=audio.inputSpansMs.at(-1)?.end
// A longer recording can include a later autonomous turn. Measure the answer to
// this exact final host input, not whichever assistant entry happens to be last.
const answer=trial.final.room.entries.find(entry=>entry.role==='assistant' && entry.source==='host' &&
  entry.replyingTo===transcript?.text && entry.timings?.ttsRequestedAt>transcript?.at)
const timings=answer?.timings??{}
// Later sentences can finish synthesis first. Only the leading request can start this turn's audio.
const preparedSpeech=Number.isFinite(timings.ttsPreparedAt)?trial.speechTrace?.find(call=>call.text && Math.abs(call.at-timings.ttsPreparedAt)<20):undefined
const leadingSpeech=preparedSpeech??trial.speechTrace?.find(call=>call.text && call.at>=timings.ttsRequestedAt)
const leadingPcm=leadingSpeech?.events.find(event=>event.type==='audio')?.at
const firstSound=answer?audio.outputSpansMs.find(span=>span.start>=Math.max(relative(transcript?.at),relative(timings.executionAt)))?.start:undefined
const tasks=new Map()
for(const event of trial.recognitionTrace??[]) {
  if(!event.task)continue
  if(!tasks.has(event.task))tasks.set(event.task,{task:event.task,sentBytes:0})
  const task=tasks.get(event.task)
  if(event.event==='run-task')task.open=relative(event.at)
  if(event.bytes){task.firstChunk??=relative(event.at);task.lastChunk=relative(event.at);task.sentBytes+=event.bytes}
  if(event.event==='finish-task')task.finish=relative(event.at)
  if(event.event==='task-finished')task.completed=relative(event.at)
  if(event.text){task.lastText=relative(event.at);task.tail=event.text.slice(-45);task.providerEnd=event.end}
  if(event.text && event.sentenceEnd)task.lastConfirmed=relative(event.at)
}
const report={label,inputSha256:trial.inputSha256,transportHealthy:trial.transportHealthy,userSessionUnchanged:trial.userSessionUnchanged,
  measurement:'Input end and first sound use rendered PCM. Other columns use process receipt timestamps, not physical acoustic clocks.',
  inputEndMs:inputEnd,finalTranscriptMs:relative(transcript?.at),executionMs:relative(timings.executionAt),firstTextMs:relative(timings.firstTextAt),
  ttsRequestMs:relative(timings.ttsRequestedAt),firstPcmMs:relative(leadingPcm),anySentenceFirstPcmMs:relative(timings.firstPcmAt),scheduledMs:relative(timings.playbackScheduledReceiptAt),firstSoundMs:firstSound,
  answerPrepared:Boolean(timings.answerPrepared),preparationStartedMs:relative(timings.decisionStartedAt),preparationReadyMs:relative(timings.decisionReadyAt),
  preparedTtsMs:relative(timings.ttsPreparedAt),preparedFirstPcmMs:relative(preparedSpeech?leadingPcm:timings.preparedFirstPcmAt),
  endToSoundMs:firstSound===undefined?null:firstSound-inputEnd,
  answer:answer?.text,asrTasks:[...tasks.values()].filter(task=>task.sentBytes).map(task=>({...task,audioMs:task.sentBytes/32})),
  floor:audio.receipts.filter(event=>event.type==='floor')}
writeFileSync(prefix+'-latency.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report))
