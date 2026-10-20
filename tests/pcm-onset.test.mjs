import test from 'node:test'
import assert from 'node:assert/strict'
import {PcmOnset} from '../apps/cohost/pcm-onset.mjs'
import {SpeechOutput} from '../apps/cohost/speech-output.mjs'

const frame=pcm=>({type:'audio',sampleRate:24000,pcm:pcm.toString('base64')})
test('onset padding spans packets, preserves quiet consonants and never removes a later pause',()=>{
  const onset=new PcmOnset()
  for(let i=0;i<10;i++)assert.equal(onset.accept(frame(Buffer.alloc(19200))),null)
  assert.equal(onset.leading.length,1920,'silence storage stays bounded at 40 ms')
  const pcm=Buffer.alloc(9600)
  pcm.writeInt16LE(32,200)
  const first=Buffer.from(onset.accept(frame(pcm)).pcm,'base64')
  assert.equal(first.length,11320)
  assert.equal(first.readInt16LE(1920),32)
  const pause=frame(Buffer.alloc(19200))
  assert.equal(onset.accept(pause),pause,'a pause after onset is preserved exactly')
})

test('only an explicitly requested onset trim changes direct speech, and cancellation blocks later audio',async()=>{
  const pcm=Buffer.alloc(19200);pcm.writeInt16LE(100,12000)
  for(const trimStart of [false,true]) {
    let emit,release
    const output=new SpeechOutput({engine:'qwen',voice:'Vivian',qwenKey:'sk-fixture',qwen:options=>{
      emit=options.onEvent;return new Promise(resolve=>release=resolve)
    }})
    const controller=new AbortController(),heard=[]
    const work=output.stream('真的？我觉得可以。',{trimStart,signal:controller.signal,emit:event=>heard.push(event)})
    await new Promise(resolve=>setImmediate(resolve))
    emit(frame(pcm))
    assert.equal(Buffer.from(heard[0].pcm,'base64').length,trimStart?9120:19200)
    controller.abort();assert.throws(()=>emit(frame(pcm)))
    release({});await assert.rejects(work);assert.equal(heard.length,1)
    output.close()
  }
})
