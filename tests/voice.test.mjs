import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { WindowsVoice } from '../apps/cohost/windows-voice.mjs'
import { createApp } from '../apps/cohost/server.mjs'

function worker() {
  const child = new EventEmitter()
  Object.assign(child, {stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:0,kill() {}})
  child.commands = []
  child.stdin.on('data', data => { for (const line of data.toString().trim().split('\n')) child.commands.push(JSON.parse(line)) })
  child.emitFrame = frame => child.stdout.write(JSON.stringify(frame) + '\n')
  return child
}
test('microphone owner, final deduplication, confidence and stale workers are isolated', () => {
  let now = 100, stops = 0
  const speech = [], children = []
  const voice = new WindowsVoice({supported:true, now:()=>now,launch:()=>{const c=worker();children.push(c);return c},onSpeech:e=>speech.push(e),onStop:()=>stops++})
  voice.start('one',false)
  assert.throws(()=>voice.start('two',false),/另一页/)
  children[0].emitFrame({type:'ready',voice:'test'})
  children[0].emitFrame({type:'speech-start',utterance:1})
  children[0].emitFrame({type:'partial',utterance:1,text:'小鲸鱼'})
  assert.equal(speech.length,1,'partial recognition never becomes a final host statement')
  children[0].emitFrame({type:'final',utterance:1,text:'小鲸鱼，你觉得呢？',confidence:0.9})
  children[0].emitFrame({type:'final',utterance:1,text:'重复',confidence:0.9})
  assert.deepEqual(speech.map(e=>e.type),['speech-start','transcript','speech-end'])
  now=200
  children[0].emitFrame({type:'speech-start',utterance:2})
  children[0].emitFrame({type:'final',utterance:2,text:'噪声',confidence:0.1})
  assert.equal(speech.filter(e=>e.type==='transcript').length,1)
  voice.stop();voice.start('two',false)
  children[0].emitFrame({type:'speech-start',utterance:3})
  assert.equal(voice.utterance,null)
  now=9000;voice.tick()
  assert.equal(voice.snapshot().active,false)
  assert.equal(stops,2)
})
test('native playback reports completed prefixes and rejects late cancelled prompts', () => {
  const child=worker(), events=[]
  const voice=new WindowsVoice({supported:true,launch:()=>child,onPlayback:e=>{events.push(e);return true}})
  voice.start('one',true);child.emitFrame({type:'ready',voice:'test'})
  voice.speak({id:1,audioId:'a',answer:'好😀呀'})
  const id=child.commands.find(c=>c.action==='speak').id
  child.emitFrame({type:'playback-start',id})
  child.emitFrame({type:'playback-progress',id,playedChars:2})
  assert.equal(events.at(-1).playedChars,1,'never acknowledge half of an emoji')
  voice.cancel(1)
  child.emitFrame({type:'playback-end',id})
  assert.equal(events.length,2)
  assert.equal(child.commands.at(-1).action,'cancel')
  voice.stop()
})
test('speech worker exits release host state and never restart microphone automatically', () => {
  const child=worker();let stopped=0
  const voice=new WindowsVoice({supported:true,launch:()=>child,onStop:()=>stopped++})
  voice.start('owner',false)
  child.emit('exit',1)
  assert.equal(voice.snapshot().active,false)
  assert.equal(stopped,1)
  assert.match(voice.snapshot().error,/退出/)
})
test('real voice route drives director and keeps audio busy until native playback ends', async t => {
  const child=worker(), histories=[]
  const app=createApp({apiKey:'test-only',token:'',rehearsal:true,voiceOptions:{supported:true,launch:()=>child},
    reply:async function*({history}){histories.push(history);yield '我听见了。'}})
  app.listen(0,'127.0.0.1');await once(app,'listening')
  t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r))})
  const base='http://127.0.0.1:'+app.address().port
  const post=(path,body,headers={})=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  const status=()=>fetch(base+'/api/status').then(r=>r.json())
  assert.equal((await post('voice/start',{owner:'one',output:true},{Origin:'http://unrelated.example'})).status,403)
  assert.equal((await post('voice/start',{owner:'one',output:true})).status,200)
  child.emitFrame({type:'ready',voice:'test'})
  child.emitFrame({type:'speech-start',utterance:1})
  child.emitFrame({type:'final',utterance:1,text:'小鲸鱼，你觉得今天怎么样？',confidence:.9})
  const s=await status()
  assert.equal(s.hostSpeaking,false)
  assert.equal(s.room.entries.filter(e=>e.role==='host').length,1)
  const body={source:'director',decision:s.director.candidate.id,engine:'deepseek'}
  assert.equal((await post('reply',body)).status,409,'other tabs cannot steal the voice reply')
  const response=await post('reply',{...body,voiceOwner:'one'})
  assert.equal(response.status,200);await response.text()
  assert.equal((await status()).busy,true)
  const command=child.commands.find(c=>c.action==='speak')
  assert.equal(command.text,'我听见了。')
  child.emitFrame({type:'playback-start',id:command.id})
  assert.equal((await status()).playback,'playing')
  child.emitFrame({type:'playback-progress',id:command.id,playedChars:2})
  await post('interrupt',{})
  assert.equal(child.commands.at(-1).action,'cancel')
  child.emitFrame({type:'playback-end',id:command.id})
  assert.equal((await status()).busy,false)
  await post('voice/stop',{owner:'one'})
  await (await post('reply',{source:'host',text:'继续'})).text()
  assert.equal(histories[1].at(-1).content,'我听','only actually acknowledged audio enters history')
})
