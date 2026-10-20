import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { parse } from 'valibot'
import { createApp } from '../apps/cohost/server.mjs'
import { StatusStream } from '../apps/cohost/status-stream.mjs'
import { StatusReplica, statusMessageSchema } from '../packages/cohost-contracts/status.ts'

async function start(t, options={}) {
  const server=createApp({apiKey:'',token:'',...options})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const base=`http://127.0.0.1:${server.address().port}/api/`
  return {base,post:(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
}
async function stream(t,base,headers={}) {
  const controller=new AbortController()
  t.after(()=>controller.abort())
  const response=await fetch(base+'status/events',{headers,signal:controller.signal})
  assert.equal(response.status,200)
  const reader=response.body.getReader(),decoder=new TextDecoder()
  let pending=''
  return {close:()=>controller.abort(),async next() {
    const timeout=setTimeout(()=>controller.abort(),3000)
    try {
      while(!pending.includes('\n')) {
        const {done,value}=await reader.read()
        assert.equal(done,false)
        pending+=decoder.decode(value,{stream:true})
      }
      const end=pending.indexOf('\n'),line=pending.slice(0,end)
      pending=pending.slice(end+1)
      return {frame:parse(statusMessageSchema,JSON.parse(line)).body,bytes:Buffer.byteLength(line)}
    } finally {clearTimeout(timeout)}
  }}
}

test('status stream preserves auth and CORS and never includes model credentials',async t=>{
  const {base}=await start(t,{token:'operator-secret',apiKey:'model-secret'})
  assert.equal((await fetch(base+'status/events')).status,401)
  assert.equal((await fetch(base+'status/events',{headers:{Authorization:'Bearer operator-secret',Origin:'https://invalid.example'}})).status,403)
  const subscription=await stream(t,base,{Authorization:'Bearer operator-secret',Origin:'http://127.0.0.1:5174'})
  const {frame}=await subscription.next()
  assert.equal(frame.kind,'snapshot')
  assert.equal(JSON.stringify(frame).includes('model-secret'),false)
  assert.equal(JSON.stringify(frame).includes('operator-secret'),false)
})

test('state changes use deltas, idle pulses omit chat, reconnect starts with current snapshot',async t=>{
  const {base,post}=await start(t,{roomSnapshot:{entries:Array.from({length:200},(_,n)=>({id:n+1,role:'host',text:'旧聊天内容'.repeat(40),at:n}))}})
  const subscription=await stream(t,base)
  const initial=await subscription.next(),replica=new StatusReplica()
  replica.accept(initial.frame)
  const oldEntry=replica.state.room.entries[0]
  assert.equal((await post('mute',{value:true})).status,200)
  const change=await subscription.next()
  assert.equal(change.frame.kind,'patch')
  assert.equal(change.frame.changes.muted,true)
  assert.ok(change.frame.room.upsert.length<5)
  assert.equal(change.frame.room.upsert.some(e=>e.id===1),false)
  replica.accept(change.frame)
  assert.equal(replica.state.room.entries[0],oldEntry)
  const pulse=await subscription.next()
  assert.equal(pulse.frame.kind,'pulse')
  assert.ok(pulse.bytes<initial.bytes/50)
  assert.equal('room' in pulse.frame,false)
  subscription.close()
  const reconnect=await stream(t,base)
  const {frame}=await reconnect.next()
  assert.equal(frame.kind,'snapshot')
  assert.equal(frame.status.muted,true)
  assert.equal(frame.status.room.version,replica.state.room.version)
})

test('replica rejects gaps and old epochs, ignores duplicates, handles retention and session reset',async t=>{
  const {base}=await start(t)
  const subscription=await stream(t,base)
  const {frame}=await subscription.next()
  const replica=new StatusReplica();replica.accept(frame)
  const patch={kind:'patch',epoch:frame.epoch,base:frame.revision,revision:frame.revision+1,changes:{muted:true},room:{session:frame.status.room.session,version:1,upsert:[{id:1,revision:1,role:'host',text:'你好',at:1}],removed:[]}}
  const state=replica.accept(patch)
  assert.equal(replica.accept(patch),state)
  assert.throws(()=>replica.accept({...patch,base:patch.revision+1,revision:patch.revision+2}),/gap/)
  assert.throws(()=>replica.accept({...patch,epoch:'old'}),/snapshot/)
  replica.accept({...patch,base:patch.revision,revision:patch.revision+1,room:{...patch.room,version:2,upsert:[],removed:[1]}})
  assert.equal(replica.state.room.entries.length,0)
  replica.accept({...frame,epoch:'restart',status:{...frame.status,room:{session:'new',version:0,entries:[]}}})
  assert.equal(replica.state.room.session,'new')
})

test('a bounded number of stream connections protects local runtime resources',async t=>{
  const {base}=await start(t)
  for(let i=0;i<8;i++)await stream(t,base)
  assert.equal((await fetch(base+'status/events')).status,429)
})

test('a stalled transport is disconnected without accumulating outgoing frames',async t=>{
  const {base}=await start(t)
  let current=await (await fetch(base+'status')).json()
  const publisher=new StatusStream(()=>current)
  t.after(()=>publisher.close())
  class SlowResponse extends EventEmitter {
    writes=0
    destroyed=false
    writeHead() {}
    flushHeaders() {}
    write() { return ++this.writes===1 }
    destroy() { this.destroyed=true;this.emit('close') }
  }
  const response=new SlowResponse()
  publisher.subscribe(response)
  current={...current,muted:true}
  publisher.publish()
  assert.equal(response.destroyed,true)
  assert.equal(publisher.clients.size,0)
  for(let i=0;i<10;i++){current={...current,muted:!current.muted};publisher.publish()}
  assert.equal(response.writes,2)
})
