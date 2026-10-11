import { once, EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import assert from 'node:assert/strict'
import { createApp } from '../apps/cohost/server.mjs'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const child=new EventEmitter()
Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:0,kill(){}})
let command
child.stdin.on('data',data=>{for(const line of data.toString().trim().split('\n')){const item=JSON.parse(line);if(item.action==='speak')command=item}})
const emit=frame=>child.stdout.write(JSON.stringify(frame)+'\n')
const server=createApp({apiKey:'test-only',token:'',rehearsal:true,voiceOptions:{supported:true,launch:()=>child},
 reply:async function*(){yield '听见了，我们继续聊。'}})
server.listen(0,'127.0.0.1');await once(server,'listening')
const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
const page=await browser.newPage({viewport:{width:1600,height:1040}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
try{
 await page.goto(base)
 await page.locator('#voiceStart').click()
 emit({type:'ready',voice:'test'})
 await page.locator('#voiceState').filter({hasText:'收音中'}).waitFor()
 emit({type:'speech-start',utterance:1})
 emit({type:'partial',utterance:1,text:'小鲸鱼，你觉得'})
 await page.locator('#voiceTranscript').filter({hasText:'正在听'}).waitFor()
 assert.equal(await page.locator('.message.assistant').count(),0)
 emit({type:'final',utterance:1,text:'小鲸鱼，你觉得直播怎么样？',confidence:.9})
 await page.waitForFunction(()=>document.querySelector('.message.assistant')?.textContent.includes('听见了'))
 await page.waitForFunction(()=>document.querySelector('#voiceState').textContent.includes('正在朗读'))
 assert.ok(command)
 emit({type:'playback-start',id:command.id})
 emit({type:'playback-progress',id:command.id,playedChars:3})
 await page.locator('#interrupt').click()
 emit({type:'playback-end',id:command.id})
 await page.waitForFunction(()=>!document.querySelector('#voiceState').textContent.includes('正在朗读'))
 emit({type:'speech-start',utterance:2})
 emit({type:'final',utterance:2,text:'没听清的一句话',confidence:.1})
 await page.locator('#voiceConfirm').click()
 assert.equal(await page.locator('#hostText').inputValue(),'没听清的一句话')
 await page.locator('#voiceStop').click()
 await page.locator('#voiceState').filter({hasText:'未收音'}).waitFor()
 await page.screenshot({path:'data/voice-browser.png',fullPage:true})
 await page.setViewportSize({width:390,height:844})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({pass:true,mode:'injected recognition and playback',errors}))
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
