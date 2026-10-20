import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeechFloor, isBackchannel } from '../packages/cohost-contracts/floor.ts'

test('long acknowledgment preserves an answer, but a revised clause takes away that permit', () => {
  const floor=new SpeechFloor()
  floor.transcript('嗯对对，你继续说，我在听。',false,100)
  assert.equal(floor.observe(true,16000,900),'play')
  assert.equal(floor.transcript('嗯对，但是我还没有说完',false,950),'hold')
  assert.equal(floor.review('嗯对对，你继续说，我在听。','backchannel',1000),'hold')
  assert.equal(floor.review('嗯对，但是我还没有说完','takeover',1050),'yield')
  assert.equal(floor.review('嗯对，但是我还没有说完','backchannel',1100),'yield')
})

test('unknown sustained speech stops audibly at the existing deadline and cannot hang forever', () => {
  const floor=new SpeechFloor()
  assert.equal(floor.observe(true,6400,400),'play')
  assert.equal(floor.observe(true,3840,640),'hold')
  assert.equal(floor.action(2439),'hold')
  assert.equal(floor.action(2440),'yield')
  floor.reset()
  assert.equal(floor.action(2500),'play')
})

test('an acknowledgment can resume a held answer without a new generation', () => {
  const floor=new SpeechFloor()
  assert.equal(floor.observe(true,10240,640),'hold')
  assert.equal(floor.transcript('对对，你继续',true,900),'play')
  assert.equal(floor.action(2900),'play')
})

test('quotes, negation and actual questions never take the lexical acknowledgment path', () => {
  for(const text of ['他说“你继续”','你继续什么？','对，但是我不同意','不要继续','嗯对先听我说',''])assert.equal(isBackchannel(text),false,text)
  assert.equal(isBackchannel('嗯，对对，你继续说。'),true)
})

test('incomplete acknowledgment words do not cause a pause, but a new clause revokes them', () => {
  const floor=new SpeechFloor()
  floor.transcript('嗯对，你',false,500)
  assert.equal(floor.observe(true,14000,900),'play')
  assert.equal(floor.transcript('嗯对，你继续说，我',false,1000),'play')
  assert.equal(floor.transcript('嗯对，你继续说，我还有问题',false,1100),'hold')
})

test('final text cannot retain a partial-word permit and input rollover cannot extend a hold forever', () => {
  const floor=new SpeechFloor()
  floor.transcript('嗯对，你',false,500)
  assert.equal(floor.observe(true,14000,900),'play')
  assert.equal(floor.transcript('嗯对，你',true,1000),'hold')
  floor.reset(true,1700)
  assert.equal(floor.action(2800),'yield')
})

test('first ASR partial has one bounded settling window, never renewed by new revisions', () => {
  const floor=new SpeechFloor()
  floor.transcript('文，对对',false,500)
  assert.equal(floor.observe(true,10240,640),'play')
  assert.equal(floor.transcript('们，对对',false,900),'play')
  assert.equal(floor.action(1040),'hold')
  assert.equal(floor.action(2840),'yield')
  floor.reset()
  floor.transcript('文，对对',false,3000)
  assert.equal(floor.observe(true,10240,3200),'play')
  assert.equal(floor.transcript('嗯对对',false,3330),'play')
  assert.equal(floor.transcript('嗯对但是我有问题',false,3340),'hold')
  floor.reset()
  floor.transcript('我还有问题',false,3500)
  assert.equal(floor.observe(true,10240,4140),'hold')
  floor.reset()
  floor.transcript('文，对对',false,4500)
  assert.equal(floor.observe(true,10240,5140),'play')
  assert.equal(floor.transcript('文，对对但是我有问题',false,5150),'hold')
})

// Real recording: data/listening-audio-trial/overlap-hedge-backchannel-1-analysis.json.
test('a short acknowledgment tail can settle without ASR punctuation, without permitting a takeover',()=>{
  const floor=new SpeechFloor()
  floor.transcript('文字对',false,100)
  assert.equal(isBackchannel('文字对'),false)
  assert.equal(floor.observe(true,10240,640),'play')
  assert.equal(floor.transcript('嗯，对对对',false,900),'play')
  floor.reset();floor.transcript('诶对',false,100)
  assert.equal(floor.observe(true,10240,640),'play')
  assert.equal(floor.transcript('诶对对',false,900),'play')
  assert.equal(floor.action(1040),'hold','the 400 ms window cannot be renewed')
  for(const text of ['不对','别说对','先对','等一下','我还有问题','你说的不对']) {
    floor.reset();floor.transcript(text,false,100)
    assert.equal(floor.observe(true,10240,640),'hold',text)
  }
  floor.reset();floor.transcript('文字对',true,100)
  assert.equal(floor.observe(true,10240,640),'hold','final content cannot use a provisional settling window')
})

test('semantic acknowledgment survives only explicit acknowledgment extensions, including a late review',()=>{
  const f=new SpeechFloor()
  f.transcript('文，对对',false,100)
  assert.equal(f.review('文，对对','backchannel',200),'play')
  assert.equal(f.observe(true,16000,900),'play')
  assert.equal(f.transcript('文，对对对，你',false,1000),'play')
  assert.equal(f.transcript('文，对对对，你继续说',false,1200),'play')
  assert.equal(f.review('文，对对对，你','backchannel',1300),'play')
  assert.equal(f.transcript('文，对对对，你继续说，我',false,1400),'play')
  assert.equal(f.transcript('嗯，对对对，你继续说，我在听。',true,2400),'play')
})

test('semantic acknowledgment extensions cannot protect corrections, questions, takeover or stale continued speech',()=>{
  for(const tail of ['但是我没说完','你先停','我还有问题','你说的是什么','不是这个意思','不要继续','他说你继续']) {
    const f=new SpeechFloor()
    f.transcript('文，对对',false,100);f.review('文，对对','backchannel',200)
    f.observe(true,16000,900)
    assert.equal(f.transcript('文，对对，'+tail,false,1000),'hold',tail)
    assert.equal(f.review('文，对对','backchannel',1100),'hold',tail)
    assert.equal(f.action(2800),'yield',tail)
  }
  const f=new SpeechFloor()
  f.transcript('文，对对',false,100);f.review('文，对对','backchannel',200)
  f.observe(true,16000,900);f.transcript('文，对对，你',false,1000)
  assert.equal(f.action(2201),'hold','a partial-word permit still expires after 1200 ms of continued speech')
})
