import test from 'node:test'
import assert from 'node:assert/strict'
import {PerformanceClock,PerformanceRhythm} from '../integrations/airi/performance-clock.ts'
import {applyPoseParameters,sampleNod} from '../integrations/airi/pose-control.ts'
import {Performance} from '../apps/cohost/performance.mjs'
import {sampleMotionSequence} from '../integrations/airi/motion-sequence.ts'

test('a conversational nod moves once within five degrees and then stays neutral',()=>{
  const values=Array.from({length:111},(_,index)=>sampleNod(index*10))
  assert.equal(values[0],0)
  assert.ok(values.every(value=>value<=0&&Math.abs(value*30)<=4.8+1e-6))
  const peak=values.indexOf(Math.min(...values))
  assert.ok(peak>0&&peak<values.length-1)
  assert.ok(values.slice(0,peak).every((value,index)=>value>=values[index+1]))
  assert.ok(values.slice(peak,-1).every((value,index)=>value<=values[peak+index+1]))
  for(const elapsed of [1100,1800,60000])assert.ok(Math.abs(sampleNod(elapsed))<1e-10)
})

test('audio time stops between buffers and rejects callbacks from a superseded turn',()=>{
 let now=0,audio=0,level=0.1
 const clock=new PerformanceClock(()=>now)
 clock.begin('one')
 const chunk=clock.start('one',1000,()=>audio,()=>level)
 now=audio=500;assert.equal(clock.sample().elapsedMs,500)
 now=audio=1000;clock.sample();clock.finish(chunk)
 now=4000;assert.equal(clock.sample().elapsedMs,1000);assert.equal(clock.sample().phase,'pause')
 const next=clock.start('one',2000,()=>audio,()=>level)
 audio=1300;now=4300;assert.equal(clock.sample().elapsedMs,1300)
 level=0;now=4600;audio=1600;assert.equal(clock.sample().phase,'pause')
 level=0.1;now=4700;audio=1700;assert.equal(clock.sample().phase,'playing')
 clock.end('one');assert.equal(clock.sample().phase,'ended')
 clock.end('one',true);assert.equal(clock.sample().phase,'ended','Final server pulse cannot turn completion into interruption')
 clock.begin('two');clock.finish(next);clock.end('one',true)
 assert.equal(clock.sample().phase,'waiting');assert.equal(clock.start('one',10,()=>audio,()=>level),0)
})

test('speech rhythm holds short pauses, softens long gaps, and releases only its matching playback',()=>{
 let now=0,audio=0
 const clock=new PerformanceClock(()=>now),rhythm=new PerformanceRhythm()
 const command={session:'session',id:1,audioId:'audio',startedAt:null}
 clock.begin('audio')
 assert.equal(rhythm.sample(command,clock.sample(),now).waiting,true)
 command.startedAt=0
 const chunk=clock.start('audio',1000,()=>audio,()=>0.1)
 now=audio=900;assert.equal(rhythm.sample(command,clock.sample(),now).elapsedMs,900)
 now=audio=1000;clock.finish(chunk)
 now=1300;assert.equal(rhythm.sample(command,clock.sample(),now).weight,1)
 now=2600;let beat=rhythm.sample(command,clock.sample(),now)
 assert.equal(beat.elapsedMs,1000);assert.equal(beat.weight,0.65);assert.ok(beat.poseWeight<0.4)
 const next=clock.start('audio',2000,()=>audio,()=>0.1)
 now=2800;audio=1200;beat=rhythm.sample(command,clock.sample(),now)
 assert.equal(beat.weight,1);assert.equal(beat.elapsedMs,1200)
 assert.equal(rhythm.sample({...command,id:2},clock.sample(),now).elapsedMs,0,'Late command starts at its current audio position')
 clock.finish(next);clock.end('audio');now+=225
 beat=rhythm.sample({...command,id:2},clock.sample(),now);assert.equal(beat.weight,0.5)
 now+=226;assert.equal(rhythm.sample({...command,id:2},clock.sample(),now).finished,true)
 assert.equal(rhythm.sample({...command,id:3,audioId:'different'},clock.sample(),now).waiting,true)
})

test('sparse pose composition leaves unclaimed head, eye, and mouth parameters alone',()=>{
 const params=new Map([['ParamMouthOpenY',0.7],['ParamAngleX',13],['ParamEyeLOpen',0],['ParamEyeROpen',0]])
 const core={getParameterValueById:id=>params.get(id)??0,setParameterValueById:(id,value)=>params.set(id,value)}
 applyPoseParameters(core,{headZ:0.2},['headZ'])
 assert.equal(params.get('ParamMouthOpenY'),0.7);assert.equal(params.get('ParamAngleX'),13)
 assert.equal(params.get('ParamAngleZ'),6);assert.equal(params.get('ParamEyeLOpen'),0)
 const sample=sampleMotionSequence({label:'只动尾巴',frames:[{ms:300,pose:{},components:{tailBase:0.2}}]},200)
 assert.deepEqual(sample.pose,{})
})

test('small streaming chunks cannot repeatedly erase a sustained silence interval',()=>{
 let now=0
 const clock=new PerformanceClock(()=>now)
 clock.begin('cloud')
 for(let index=0;index<12;index++){
   const chunk=clock.start('cloud',100,()=>now,()=>0)
   now+=100;clock.sample();clock.finish(chunk)
 }
 assert.equal(clock.sample().quietMs,1200)
 clock.end('cloud',true)
 assert.equal(clock.sample().phase,'cancelled')
 assert.equal(clock.start('cloud',100,()=>now,()=>1),0)
})

test('speech-bound performance survives synthesis gaps but has bounded completion and cancellation',()=>{
 let now=0;const p=new Performance({now:()=>now})
 p.play('smile',{turn:1,audioId:'audio',defer:true})
 now=5000;assert.equal(p.start(1),true)
 now=13000;assert.equal(p.snapshot().name,'smile')
 p.finish(2);assert.equal(p.snapshot().name,'smile')
 p.finish(1);now+=701;assert.equal(p.snapshot().name,'idle')
 p.play('smile',{turn:2,audioId:'next'});p.cancel(1);assert.equal(p.snapshot().name,'smile')
 p.cancel(2);assert.equal(p.snapshot().name,'idle')
 p.play('smile',{turn:3,audioId:'stalled'});now+=120001;assert.equal(p.snapshot().name,'idle')
})
