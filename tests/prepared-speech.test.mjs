import test from 'node:test'
import assert from 'node:assert/strict'
import {PreparedSpeech} from '../apps/cohost/prepared-speech.mjs'
import {Director} from '../apps/cohost/director.mjs'
import {Scheduler} from '../apps/cohost/scheduler.mjs'

test('first-sentence preparation refuses records that renderer punctuation or word limits could split',async()=>{
  let calls=0
  const speech={revision:1,async stream(_text,{emit}){calls++;emit({type:'audio',sampleRate:24000,pcm:Buffer.from([64,0,64,0]).toString('base64')});emit({type:'done'})}}
  for(const text of ['一'.repeat(25),'这句话已经完整。下一句。','数字3.14。','隐形\u200B分隔。','换\n行。'])
    assert.equal(PreparedSpeech.firstSentence(speech,text),undefined)
  assert.equal(calls,0)
  const prepared=PreparedSpeech.firstSentence(speech,'该发，推车另外算。')
  await prepared.done
  assert.equal(prepared.ready,true);assert.equal(prepared.text,'该发，推车另外算。');assert.equal(calls,1)
  prepared.close()
})

test('preparation is silent, replays once available without a second provider call, and cancels late output',async()=>{
  let calls=0,release
  const gate=new Promise(resolve=>release=resolve)
  const speech={revision:'voice-1',async stream(text,{emit,speechStyle}){assert.equal(speechStyle,'happy');calls++;emit({type:'audio',sampleRate:24000,pcm:'AAAAAA=='});await gate;emit({type:'done'})}}
  const prepared=new PreparedSpeech(speech,'猫老板巡视呢。','happy')
  assert.equal(prepared.ready,false)
  release();await prepared.done
  const heard=[];prepared.replay(prepared.text,{emit:event=>heard.push(event)})
  assert.equal(calls,1);assert.deepEqual(heard.map(e=>e.type),['audio','done'])
  prepared.close();assert.throws(()=>prepared.replay(prepared.text,{emit(){}}))
  assert.equal(prepared.frames.length,0)
})

test('control changes and expiry abort speculative transport without creating an audible turn',async()=>{
  let time=1000,signal
  const scheduler=new Scheduler({now:()=>time}),director=new Director({scheduler,now:()=>time})
  const speech={revision:'voice-1',stream(_text,options){signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))}}
  const prepared=new PreparedSpeech(speech,'短回应。','neutral')
  director.candidate={id:1,revision:0,expiresAt:1100,listening:true,text:'完整内容。',preparedSpeech:prepared}
  time=1101;director.status();await prepared.done
  assert.equal(signal.aborted,true);assert.equal(director.candidate,null);assert.equal(scheduler.active,null)
  director.close()
})

test('prepared PCM removes only outer silence and retains the quiet onset and tail margins',async()=>{
  const pcm=Buffer.alloc(24000*2)
  for(let sample=6000;sample<12000;sample++)pcm.writeInt16LE(1000,sample*2)
  const speech={revision:'voice-1',async stream(_text,{emit}){emit({type:'audio',sampleRate:24000,pcm:pcm.toString('base64')});emit({type:'done'})}}
  const prepared=new PreparedSpeech(speech,'猫老板。','neutral');await prepared.done
  const result=Buffer.from(prepared.frames[0].pcm,'base64')
  assert.equal(result.length/2,6000+960+1920)
  assert.equal(prepared.durationMs,370)
  assert.equal(result.readInt16LE(960*2),1000)
  assert.equal(result.readInt16LE(0),0)
  prepared.close()
})

test('a streaming reaction can play buffered PCM before completion and cancellation discards its remaining audio',async()=>{
  let emit,finish
  const speech={revision:'voice-1',stream(_text,options){emit=options.emit;return new Promise(resolve=>{finish=resolve})}}
  const prepared=new PreparedSpeech(speech,'确实。','neutral',Date.now,{streaming:true})
  emit({type:'audio',sampleRate:24000,pcm:Buffer.alloc(9600).toString('base64')})
  assert.equal(prepared.ready,false)
  assert.equal(prepared.playable,true)
  const heard=[],playing=prepared.replay(prepared.text,{emit:event=>heard.push(event)})
  assert.equal(heard.length,1,'first buffered audio is available before the provider finishes')
  prepared.close()
  emit({type:'audio',sampleRate:24000,pcm:Buffer.alloc(9600).toString('base64')})
  finish();await prepared.done
  await assert.rejects(playing)
  assert.equal(prepared.playable,false)
  assert.equal(heard.length,1)
  assert.equal(prepared.frames.length,0)
})

test('streaming short reactions keep onset padding but cannot claim playback for leading silence',async()=>{
  let emit,finish
  const speech={revision:'voice-1',stream(_text,options){emit=options.emit;return new Promise(resolve=>{finish=resolve})}}
  const prepared=new PreparedSpeech(speech,'确实。','neutral',Date.now,{streaming:true,trimStart:true})
  emit({type:'audio',sampleRate:24000,pcm:Buffer.alloc(19200).toString('base64')})
  assert.equal(prepared.playable,false)
  const pcm=Buffer.alloc(9600)
  for(let offset=2400;offset<pcm.length;offset+=2)pcm.writeInt16LE(1000,offset)
  emit({type:'audio',sampleRate:24000,pcm:pcm.toString('base64')})
  assert.equal(prepared.playable,true)
  const buffered=Buffer.from(prepared.frames[0].pcm,'base64')
  assert.equal(buffered.length,7200+1920)
  assert.equal(buffered.readInt16LE(1918),0)
  assert.equal(buffered.readInt16LE(1920),1000)
  finish();await prepared.done;prepared.close()
})
