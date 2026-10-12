import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,createHmac} from 'node:crypto'
import {deflateSync,brotliCompressSync} from 'node:zlib'
import {setTimeout as delay} from 'node:timers/promises'
import {once} from 'node:events'
import {BilibiliLive,biliPacket,decodeBiliPackets,normalizeBiliDanmaku,signBilibili} from '../apps/cohost/bilibili.mjs'
import {createApp} from '../apps/cohost/server.mjs'
import {Scheduler} from '../apps/cohost/scheduler.mjs'
import {Director} from '../apps/cohost/director.mjs'
import {Scene} from '../apps/cohost/scene.mjs'
import {Participation} from '../apps/cohost/participation.mjs'

const config={accessKeyId:'fixture-id',accessKeySecret:'fixture-secret',appId:'1234567890123456789',code:'fixture-anchor-code'}
const dm=(id='one',extra={})=>({cmd:'LIVE_OPEN_PLATFORM_DM',data:{msg_id:id,room_id:123,open_id:'viewer-open-id',uname:'真实观众',msg:'这只猫把跑步机当房子了',timestamp:Math.floor(Date.now()/1000),...extra}})
const waitFor=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await delay(10)}assert.fail('condition timed out')}
function fixture(options={}) {
 const sockets=[],requests=[],messages=[]
 class Socket extends EventTarget {
  constructor(url){super();this.url=url;this.sent=[];sockets.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
  send(bytes){const packet=decodeBiliPackets(bytes)[0];this.sent.push(packet);if(packet.operation===7)queueMicrotask(()=>this.emit(biliPacket(8,'{"code":0}')));if(packet.operation===2)queueMicrotask(()=>this.emit(biliPacket(3,Buffer.alloc(4))))}
  emit(bytes){this.dispatchEvent(new MessageEvent('message',{data:bytes}))}
  close(){this.closed=true;this.dispatchEvent(new Event('close'))}
 }
 const fetchImpl=async(url,init)=>{
  requests.push({url,body:init.body})
  if(url.endsWith('/start'))return Response.json({code:0,data:{game_info:{game_id:'fixture-game'},anchor_info:{room_id:123},websocket_info:{wss_link:['wss://fixture.bilibili.com/sub'],auth_body:'fixture-auth'}}})
  return Response.json({code:0,data:{}})
 }
 const client=new BilibiliLive({config,fetchImpl,WebSocketImpl:Socket,onMessage:m=>{messages.push(m);return true},retryMs:5,heartbeatMs:15,...options})
 return {client,sockets,requests,messages,fetchImpl,Socket}
}

test('official signature covers exact UTF-8 body with sorted headers and no trailing newline',()=>{
 const body='{"app_id":123,"code":"测试"}',headers=signBilibili(body,config,1700000000,'fixed-nonce')
 assert.equal(headers['x-bili-content-md5'],createHash('md5').update(body).digest('hex'))
 const canonical=`x-bili-accesskeyid:fixture-id\nx-bili-content-md5:${headers['x-bili-content-md5']}\nx-bili-signature-method:HMAC-SHA256\nx-bili-signature-nonce:fixed-nonce\nx-bili-signature-version:1.0\nx-bili-timestamp:1700000000`
 assert.equal(headers.Authorization,createHmac('sha256',config.accessKeySecret).update(canonical).digest('hex'))
})

test('binary decoder handles concatenated zlib and brotli packets and rejects corrupt or oversized data',()=>{
 const raw=Buffer.concat([biliPacket(5,JSON.stringify(dm()),0),biliPacket(3,Buffer.alloc(4))])
 for(const [version,compress] of [[2,deflateSync],[3,brotliCompressSync]]) {
  const decoded=decodeBiliPackets(biliPacket(5,compress(raw),version))
  assert.equal(decoded.length,2);assert.equal(JSON.parse(decoded[0].body.toString()).data.msg_id,'one')
 }
 const broken=biliPacket(5,'{}');broken.writeUInt32BE(0,0)
 assert.throws(()=>decodeBiliPackets(broken));assert.throws(()=>decodeBiliPackets(Buffer.alloc(15)))
 assert.throws(()=>decodeBiliPackets(biliPacket(5,brotliCompressSync(Buffer.alloc(3*1024*1024)),3)))
})

test('only current-room fresh comments enter chat; identities stay separate from nicknames',()=>{
 const a=normalizeBiliDanmaku(dm(),123)
 assert.equal(a.platform,'bilibili');assert.equal(a.real,true);assert.equal(a.userId,'viewer-open-id');assert.equal(a.displayName,'真实观众')
 assert.equal(a.mentioned,false)
 assert.equal(normalizeBiliDanmaku(dm('one',{uname:'改名'}),123).id,a.id)
 assert.equal(normalizeBiliDanmaku(dm(),456),null)
 assert.equal(normalizeBiliDanmaku(dm('old',{timestamp:1}),123),null)
 assert.equal(normalizeBiliDanmaku(dm('long',{msg:'x'.repeat(501)}),123),null)
 assert.equal(normalizeBiliDanmaku({cmd:'LIVE_OPEN_PLATFORM_SEND_GIFT'},123),null)
 assert.equal(normalizeBiliDanmaku(dm('call',{msg:'小鲸鱼，讲个笑话'}),123).mentioned,true)
 assert.equal(normalizeBiliDanmaku(dm('none',{open_id:undefined}),123),null)
})

test('missing configuration does not contact Bilibili and status never exposes credentials',async()=>{
 let calls=0;const client=new BilibiliLive({config:{},fetchImpl:()=>{calls++}})
 assert.equal(client.start().error,'configuration');assert.equal(calls,0)
 assert.equal(client.status().missing.length,4)
 const complete=new BilibiliLive({config})
 assert.equal(complete.status().configured,true)
 for(const secret of Object.values(config))assert.ok(!JSON.stringify(complete.status()).includes(secret))
 await client.stop()
})

test('connection authenticates, heartbeats, deduplicates start and ends owned session on stop',async t=>{
 const f=fixture();t.after(()=>f.client.stop())
 f.client.start();f.client.start();await waitFor(()=>f.client.state==='connected')
 assert.equal(f.sockets.length,1);assert.equal(f.sockets[0].sent[0].body.toString(),'fixture-auth')
 assert.ok(f.requests[0].body.includes('"app_id":1234567890123456789'))
 f.sockets[0].emit(biliPacket(5,JSON.stringify(dm()),0))
 assert.equal(f.messages.length,1)
 await waitFor(()=>f.requests.some(x=>x.url.endsWith('/heartbeat')))
 await f.client.stop()
 assert.equal(f.client.state,'disconnected');assert.ok(f.requests.some(x=>x.url.endsWith('/end')))
 const before=f.requests.length;f.sockets[0].emit(biliPacket(5,JSON.stringify(dm('late'))));await delay(25)
 assert.equal(f.messages.length,1);assert.equal(f.requests.length,before)
})

test('closed connection reconnects and stale socket cannot deliver messages',async t=>{
 const f=fixture();t.after(()=>f.client.stop());f.client.start();await waitFor(()=>f.client.state==='connected')
 const old=f.sockets[0];old.close();await waitFor(()=>f.sockets.length===2 && f.client.state==='connected')
 old.emit(biliPacket(5,JSON.stringify(dm('late'))));assert.equal(f.messages.length,0)
 f.sockets[1].emit(biliPacket(5,JSON.stringify(dm('new'))));assert.equal(f.messages.length,1)
})

test('provider errors redact raw text and stop without retrying invalid credentials',async()=>{
 const f=fixture({fetchImpl:async()=>Response.json({code:4002,message:'fixture-secret fixture-anchor-code'})})
 f.client.start();await waitFor(()=>f.client.state==='error')
 assert.equal(f.client.status().error,'platform');assert.equal(f.client.retries,0)
 assert.ok(!JSON.stringify(f.client.status()).includes('fixture-secret'));await f.client.stop()
})

test('burst intake is bounded before scene and model work',()=>{
 const f=fixture({now:()=>Date.now()});f.client.roomId='123'
 for(let i=0;i<100;i++)f.client.receive(dm(String(i)))
 assert.equal(f.messages.length,30);assert.equal(f.client.dropped,70)
})

test('delayed live messages keep their original expiry instead of earning a fresh queue lifetime',()=>{
 let now=20_000;const s=new Scheduler({now:()=>now})
 s.enqueue({id:'delayed',platform:'bilibili',userId:'a',text:'旧问题',real:true,sourceAt:1000})
 assert.equal(s.eligibleViewers().length,1)
 now+=1001;assert.equal(s.eligibleViewers().length,0)
})

test('stopping while start returns late closes the owned session without opening a socket',async()=>{
 let release;const ended=[]
 const f=fixture({fetchImpl:async(url,init)=>{
  if(url.endsWith('/start'))return new Promise(resolve=>{release=resolve})
  ended.push(JSON.parse(init.body).game_id);return Response.json({code:0})
 }})
 f.client.start();const stopping=f.client.stop()
 release(Response.json({code:0,data:{game_info:{game_id:'late-session'},anchor_info:{room_id:123},websocket_info:{wss_link:['wss://fixture.bilibili.com/sub'],auth_body:'auth'}}}))
 await stopping;assert.equal(f.sockets.length,0);assert.equal(f.client.state,'disconnected');assert.deepEqual(ended,['late-session'])
})

test('untrusted socket URL is rejected before sending authentication',async()=>{
 const f=fixture({fetchImpl:async()=>Response.json({code:0,data:{game_info:{game_id:'invalid-session'},anchor_info:{room_id:123},websocket_info:{wss_link:['wss://bilibili.com.evil.invalid/sub'],auth_body:'auth'}}})})
 f.client.start();await waitFor(()=>f.client.state==='error');assert.equal(f.sockets.length,0)
 assert.equal(f.client.error,'protocol');await f.client.stop()
})

test('real comments reach shared chat exactly once and public simulated inputs cannot forge real status',async t=>{
 const f=fixture(),scheduler=new Scheduler()
 const app=createApp({apiKey:'',scheduler,bilibiliOptions:{config,fetchImpl:f.fetchImpl,WebSocketImpl:f.Socket}})
 app.listen(0,'127.0.0.1');await once(app,'listening')
 t.after(()=>new Promise(resolve=>{app.closeAllConnections();app.close(resolve)}))
 const base=`http://127.0.0.1:${app.address().port}`
 const post=(path,body={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
 await post('/api/bilibili/start');await waitFor(()=>f.sockets.length && f.sockets[0].sent.length>=2)
 for(let i=0;i<2;i++)f.sockets[0].emit(biliPacket(5,JSON.stringify(dm())))
 let state=await fetch(base+'/api/status').then(r=>r.json())
 assert.equal(state.room.entries.filter(x=>x.role==='viewer').length,1);assert.equal(state.bilibili.accepted,1)
 assert.equal(scheduler.eligibleViewers().length,1)
 await post('/api/danmaku',{platform:'bilibili',id:'fake',userId:'fake',text:'模拟',real:true})
 state=await fetch(base+'/api/status').then(r=>r.json())
 assert.equal(state.room.entries.find(x=>x.text==='模拟').real,false)
 assert.equal(scheduler.eligibleViewers().length,1)
 await post('/api/bilibili/stop')
})

test('viewer bursts do not abort planning and next batch is rate-limited without delaying host input',async t=>{
 let now=1000,resolve,calls=0,lastSignal
 const scheduler=new Scheduler({now:()=>now}),director=new Director({scheduler,now:()=>now}),scene=new Scene()
 director.event({type:'mode',value:'auto'});director.event({type:'viewer-window',value:true})
 const p=new Participation({director,scheduler,scene,enabled:true,now:()=>now,plan:async(s,{signal})=>{calls++;lastSignal=signal;return new Promise(r=>{resolve=r})}})
 t.after(()=>{p.close();director.close()})
 const enqueue=id=>scheduler.enqueue({id,platform:'bilibili',userId:id,text:'猫咪睡在跑步机上',real:true})
 enqueue('1');const first=p.run()
 for(let i=2;i<50;i++){enqueue(String(i));p.notify()}
 assert.equal(lastSignal.aborted,false)
 resolve({action:'wait',reason:'等主播说完',text:''});await first;await p.run();assert.equal(calls,1)
 now+=3000;const second=p.run();assert.equal(calls,2)
 director.event({type:'speech-start',utterance:1});director.event({type:'transcript',utterance:1,text:'你说它是不是故意的？',final:true});director.event({type:'speech-end',utterance:1})
 p.notify();assert.equal(lastSignal.aborted,true)
 resolve({action:'wait',reason:'旧决定',text:''});await second
 const host=p.run();assert.equal(calls,3,'host bypasses viewer quota')
 resolve({action:'wait',reason:'先听着',text:''});await host
})
