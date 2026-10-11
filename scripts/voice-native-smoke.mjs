import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
 fileURLToPath(new URL('./windows-speech.ps1',import.meta.url)),'-Mode','fixture','-WavePath',
 fileURLToPath(new URL('../data/voice-fixture.wav',import.meta.url))],{windowsHide:true})
const frames=[];let error='',inputDone=false,playbackDone=false
child.stderr.on('data',data=>error+=data)
const lines=createInterface({input:child.stdout})
lines.on('line',line=>{
 const frame=JSON.parse(line);frames.push(frame)
 if(frame.type==='ready')child.stdin.write(JSON.stringify({action:'speak',id:'native-trial',text:'你好，语音试播已经准备好了。'})+'\n')
 if(frame.type==='input-ended')inputDone=true
 if(frame.type==='playback-end'&&frame.id==='native-trial')playbackDone=true
 if((inputDone&&playbackDone)||frame.type==='error')child.stdin.end()
})
const timer=setTimeout(()=>child.kill(),25000)
await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
clearTimeout(timer);lines.close()
const finals=frames.filter(f=>f.type==='final')
const report={kind:'Windows system TTS audio file into real offline ASR; no human microphone validation',finals,nativePlayback:playbackDone,progressEvents:frames.filter(f=>f.type==='playback-progress'&&f.id==='native-trial').length,ready:frames.some(f=>f.type==='ready'),error}
writeFileSync('data/voice-native-result.json',JSON.stringify(report,null,2))
assert.equal(report.ready,true,error)
assert.ok(finals.some(f=>f.text.length>4),'real ASR must recognize the generated Chinese audio')
assert.equal(report.nativePlayback,true)
assert.ok(report.progressEvents>0)
console.log(JSON.stringify(report))
