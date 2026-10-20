import {testCapabilities} from './fixtures/performance.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {RuntimeProfile} from '../apps/cohost/runtime-profile.mjs'
import {createApp} from '../apps/cohost/server.mjs'
import {streamReply} from '../apps/cohost/deepseek.mjs'
import {planParticipation} from '../apps/cohost/participation-model.mjs'
const profile=(stage='desktop')=>({stage,owner:stage+'-owner',card:{id:'card-1',name:'测试角色',prompt:'说话简短，喜欢海洋。'},capabilities:testCapabilities(['开心兴奋'],false)})

test('the playback renderer owns persona and capabilities across competing windows',()=>{
 let owner=null
 const p=new RuntimeProfile({owner:()=>owner})
 p.update(profile())
 p.update({...profile('web'),card:{...profile().card,name:'网页角色'}})
 owner='web-owner';assert.equal(p.snapshot().name,'网页角色')
 p.update({...profile('web'),owner:'another-window',card:{...profile().card,name:'别的窗口'}})
 assert.equal(p.snapshot().name,'网页角色')
 owner='unknown-window';assert.equal(p.snapshot().name,'小鲸鱼');assert.deepEqual(p.snapshot().expressions,[])
})
test('runtime profile validates metadata, prioritizes desktop and expires capabilities',()=>{
 let now=0;const p=new RuntimeProfile({now:()=>now})
 p.update(profile('web'));p.update({...profile(),card:{...profile().card,name:'桌面角色'}})
 assert.equal(p.snapshot().name,'桌面角色')
 assert.throws(()=>p.update({...profile(),capabilities:{...profile().capabilities,expressions:['unknown']}}))
 assert.throws(()=>p.update({...profile(),card:{...profile().card,prompt:''}}))
 now=30001;assert.equal(p.snapshot().name,'桌面角色');assert.deepEqual(p.snapshot().expressions,[])
})
test('expression policy rejects aliases and component bypass while preserving spoken text',()=>{
 const p=new RuntimeProfile();p.update(profile())
 const result=p.filter({performance:'pout',text:'你好',motion:{label:'test',frames:[{ms:600,pose:{headZ:0.1},expression:{name:'think',strength:1},components:{tailBase:1}},{ms:600,pose:{},expression:{name:'smile',strength:1}}]}})
 assert.equal(result.performance,'idle');assert.equal(result.text,'你好')
 assert.equal(result.motion.frames[0].expression,undefined);assert.equal(result.motion.frames[0].components,undefined)
 assert.equal(result.motion.frames[1].expression.name,'smile')
})
test('director and streamed reply use the same persona and filtered capabilities',async()=>{
 const p=new RuntimeProfile();p.update(profile());const snapshot=p.snapshot();const calls=[]
 const fetchImpl=async(url,opts)=>{calls.push(JSON.parse(opts.body));return calls.length===1 ? new Response('data: [DONE]\n\n') : new Response(JSON.stringify({choices:[{message:{tool_calls:[{function:{name:'participate',arguments:JSON.stringify({action:'wait',hostIntent:'none',reason:'等一下',text:'',targetId:'',platform:'',performance:'idle'})}}]}}]}))}
 const signal=new AbortController().signal
 for await(const chunk of streamReply({apiKey:'test',profile:snapshot,input:{text:'你好'},signal,fetchImpl}))assert.fail(chunk)
 await planParticipation({}, {apiKey:'test',model:'test',profile:snapshot,signal,fetchImpl})
 for(const call of calls){assert.ok(call.messages[0].content.includes(snapshot.prompt));assert.ok(!call.messages[0].content.includes('你是 DeepSeek 小鲸鱼'));assert.ok(call.messages[0].content.includes('禁止 components'))}
})
test('HTTP profile updates apply to the next generation and report actual card identity',async t=>{
 const seen=[];const app=createApp({apiKey:'test',token:'',reply:async function*({profile}){seen.push(profile);yield '收到'}})
 app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.closeAllConnections();app.close()})
 const url='http://127.0.0.1:'+app.address().port
 const post=(path,body)=>fetch(url+'/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 assert.equal((await post('runtime-profile',profile())).status,200)
 await (await post('reply',{source:'host',text:'你好'})).text()
 const edited={...profile(),card:{...profile().card,prompt:'现在喜欢星空。'}}
 await post('runtime-profile',edited);await (await post('reply',{source:'host',text:'再说一句'})).text()
 assert.equal(seen[0].prompt,profile().card.prompt);assert.equal(seen[1].prompt,edited.card.prompt)
 const status=await fetch(url+'/api/status').then(r=>r.json());assert.equal(status.configuration.cardId,'card-1');assert.equal(status.persona,'测试角色')
 assert.ok(status.configuration.cardFingerprint);assert.equal(JSON.stringify(status).includes(edited.card.prompt),false)
})
