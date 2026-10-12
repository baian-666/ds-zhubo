import { createHash, createHmac, randomUUID } from 'node:crypto'
import { inflateSync, brotliDecompressSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'

const maxPacket = 2 * 1024 * 1024
const fault = code => Object.assign(new Error('Bilibili connection failed'), { code })
export function bilibiliConfig(env = process.env) {
  return { accessKeyId:env.BILIBILI_ACCESS_KEY_ID?.trim(), accessKeySecret:env.BILIBILI_ACCESS_KEY_SECRET?.trim(),
    appId:env.BILIBILI_APP_ID?.trim(), code:env.BILIBILI_ANCHOR_CODE?.trim() }
}
export function signBilibili(body, config, timestamp = Math.floor(Date.now()/1000), nonce = randomUUID()) {
  const headers = {
    'x-bili-accesskeyid':config.accessKeyId,
    'x-bili-content-md5':createHash('md5').update(body).digest('hex'),
    'x-bili-signature-method':'HMAC-SHA256', 'x-bili-signature-nonce':nonce,
    'x-bili-signature-version':'1.0', 'x-bili-timestamp':String(timestamp),
  }
  const canonical = Object.keys(headers).sort().map(key=>`${key}:${headers[key]}`).join('\n')
  return {...headers, Authorization:createHmac('sha256',config.accessKeySecret).update(canonical).digest('hex'),
    'Content-Type':'application/json', Accept:'application/json'}
}
export function biliPacket(operation, body = '', version = 1) {
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(body)
  const packet=Buffer.alloc(16+bytes.length)
  packet.writeUInt32BE(packet.length,0);packet.writeUInt16BE(16,4);packet.writeUInt16BE(version,6)
  packet.writeUInt32BE(operation,8);packet.writeUInt32BE(1,12);bytes.copy(packet,16)
  return packet
}
// Each WebSocket message contains complete Bilibili packets, sometimes compressed in batches.
export function decodeBiliPackets(input, budget = {bytes:maxPacket, count:1024}, depth = 0) {
  const bytes=Buffer.from(input), packets=[]
  budget.bytes-=bytes.length
  if(budget.bytes<0 || depth>3)throw fault('protocol')
  for(let offset=0;offset<bytes.length;) {
    if(bytes.length-offset<16 || --budget.count<0)throw fault('protocol')
    const length=bytes.readUInt32BE(offset), header=bytes.readUInt16BE(offset+4)
    const version=bytes.readUInt16BE(offset+6), operation=bytes.readUInt32BE(offset+8)
    if(header<16 || length<header || offset+length>bytes.length)throw fault('protocol')
    const body=bytes.subarray(offset+header,offset+length)
    if(version===2 || version===3) {
      if(budget.bytes<=0)throw fault('protocol')
      const expanded=(version===2?inflateSync:brotliDecompressSync)(body,{maxOutputLength:budget.bytes})
      packets.push(...decodeBiliPackets(expanded,budget,depth+1))
    } else if(version===0 || version===1)packets.push({operation,body})
    else throw fault('protocol')
    offset+=length
  }
  return packets
}
export function normalizeBiliDanmaku(event, roomId, now = Date.now()) {
  if(event?.cmd!=='LIVE_OPEN_PLATFORM_DM')return null
  const d=event.data
  if(!d || String(d.room_id)!==String(roomId) || !Number.isFinite(d.timestamp) ||
    now-d.timestamp*1000>20_000 || d.timestamp*1000-now>60_000)return null
  if(typeof d.msg!=='string' || !d.msg.trim() || d.msg.length>500 || typeof d.open_id!=='string' || !d.open_id || d.open_id.length>128)return null
  const text=d.msg.trim()
  // Older official payloads lack msg_id. Identical messages in one second then share a deduplication key.
  const identity=typeof d.msg_id==='string' && d.msg_id ? d.msg_id : JSON.stringify([roomId,d.open_id,d.timestamp,text])
  return {id:createHash('sha256').update(identity).digest('hex'),platform:'bilibili',userId:d.open_id,
    displayName:typeof d.uname==='string'?d.uname.slice(0,80):'B站观众',text,real:true,
    mentioned:/小鲸鱼|大肥鱼|鲸鱼娘|助播/.test(text),selected:false,sourceAt:d.timestamp*1000}
}
function socketUrl(value) {
  try {
    const url=new URL(value)
    if(url.protocol==='wss:' && !url.username && !url.password &&
      ['bilibili.com','biliapi.com','biliapi.net'].some(domain=>url.hostname===domain || url.hostname.endsWith('.'+domain)))return url.href
  } catch {}
  throw fault('protocol')
}

export class BilibiliLive {
  constructor({config = bilibiliConfig(), fetchImpl = fetch, WebSocketImpl = WebSocket, now = Date.now,
    onMessage = () => false, heartbeatMs = 20_000, retryMs = 1000} = {}) {
    Object.assign(this,{config,fetchImpl,WebSocketImpl,now,onMessage,heartbeatMs,retryMs})
    this.state='disconnected';this.error=null;this.roomId=null;this.controller=null;this.work=null
    this.received=0;this.accepted=0;this.dropped=0;this.retries=0;this.lastMessageAt=null
    this.windowAt=0;this.windowCount=0
  }
  status() {
    const missing=Object.entries({accessKeyId:'开发者 ID',accessKeySecret:'开发者密钥',appId:'应用 ID',code:'主播身份码'})
      .filter(([key])=>!this.config[key]).map(([,name])=>name)
    const valid=/^[1-9]\d{0,18}$/.test(this.config.appId??'')
    return {configured:!missing.length && valid,missing,state:this.state,error:this.error,roomId:this.roomId,
      received:this.received,accepted:this.accepted,dropped:this.dropped,retries:this.retries,lastMessageAt:this.lastMessageAt}
  }
  start() {
    if(this.work)return this.status()
    if(!this.status().configured){this.state='error';this.error='configuration';return this.status()}
    this.controller=new AbortController();this.state='connecting';this.error=null;this.retries=0
    this.work=this.run(this.controller.signal).finally(()=>{this.work=null;this.controller=null})
    return this.status()
  }
  async stop() {
    this.controller?.abort()
    await this.work
    this.state='disconnected';this.error=null;this.roomId=null
    return this.status()
  }
  async request(path, body, signal) {
    try {
      const response=await this.fetchImpl('https://live-open.biliapi.com/v2/app/'+path,{
        method:'POST',headers:signBilibili(body,this.config),body,redirect:'error',
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(3000),
      })
      if(!response.ok)throw fault(response.status===429?'rate_limit':response.status===401 || response.status===403?'credentials':'network')
      // Do not retain provider error text or auth payloads in diagnostics.
      const chunks=[];let size=0
      for await(const chunk of response.body){size+=chunk.length;if(size>128_000)throw fault('protocol');chunks.push(chunk)}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if(result.code!==0)throw fault('platform')
      return result.data
    } catch(error) {
      if(['rate_limit','credentials','network','protocol','platform'].includes(error.code))throw error
      throw fault('network')
    }
  }
  async run(signal) {
    while(!signal.aborted) {
      let gameId
      try {
        this.state='connecting'
        // Validated decimal app IDs remain exact, including IDs beyond Number.MAX_SAFE_INTEGER.
        const data=await this.request('start',`{"app_id":${this.config.appId},"code":${JSON.stringify(this.config.code)}}`,signal)
        gameId=data?.game_info?.game_id
        if(typeof gameId!=='string' || !gameId || gameId.length>256)throw fault('protocol')
        const info=data.websocket_info
        if(typeof info?.auth_body!=='string' || info.auth_body.length>16_384 || !Array.isArray(info.wss_link) || !info.wss_link.length)throw fault('protocol')
        const roomId=data.anchor_info?.room_id
        if(!Number.isSafeInteger(roomId) || roomId<=0)throw fault('protocol')
        this.roomId=String(roomId)
        const links=info.wss_link.slice(0,5).map(socketUrl)
        await this.connect(links[this.retries%links.length],info.auth_body,gameId,signal)
      } catch(error) {
        if(!signal.aborted){this.error=['credentials','rate_limit','network','platform','protocol','timeout'].includes(error.code)?error.code:'network';this.state='retrying'}
      } finally {
        if(typeof gameId==='string' && gameId.length<=256) {
          try {await this.request('end',`{"app_id":${this.config.appId},"game_id":${JSON.stringify(gameId)}}`)} catch {}
        }
      }
      if(signal.aborted)break
      if(['credentials','platform','protocol'].includes(this.error) || ++this.retries>=6){this.state='error';break}
      try {await delay(Math.min(30_000,this.retryMs*2**(this.retries-1)),null,{signal})} catch {break}
    }
  }
  connect(url, auth, gameId, signal) {
    return new Promise((resolve,reject)=>{
      if(signal.aborted){resolve();return}
      const ws=new this.WebSocketImpl(url);ws.binaryType='arraybuffer'
      const connection=new AbortController()
      let done=false,authenticated=false,lastHeartbeat=this.now(),heartbeatBusy=false
      const finish=error=>{
        if(done)return
        done=true;clearTimeout(authTimer);clearInterval(timer);connection.abort()
        signal.removeEventListener('abort',abort)
        try {ws.close()} catch {}
        if(error)reject(error);else resolve()
      }
      const abort=()=>finish()
      const authTimer=setTimeout(()=>finish(fault('timeout')),10_000)
      const timer=setInterval(async()=>{
        if(!authenticated || done || heartbeatBusy)return
        if(this.now()-lastHeartbeat>60_000){finish(fault('timeout'));return}
        heartbeatBusy=true
        try {
          ws.send(biliPacket(2))
          await this.request('heartbeat',JSON.stringify({game_id:gameId}),AbortSignal.any([signal,connection.signal]))
        } catch(error){if(!done)finish(error)} finally {heartbeatBusy=false}
      },this.heartbeatMs)
      signal.addEventListener('abort',abort,{once:true})
      ws.addEventListener('open',()=>{if(!done){try{ws.send(biliPacket(7,auth))}catch{finish(fault('network'))}}})
      ws.addEventListener('error',()=>finish(fault('network')))
      ws.addEventListener('close',()=>finish(fault('network')))
      ws.addEventListener('message',event=>{
        if(done)return
        try {
          for(const packet of decodeBiliPackets(event.data)) {
            if(packet.operation===8) {
              if(JSON.parse(packet.body.toString()).code!==0)throw fault('credentials')
              authenticated=true;clearTimeout(authTimer);this.state='connected';this.error=null;lastHeartbeat=this.now()
              ws.send(biliPacket(2))
            } else if(authenticated && packet.operation===3)lastHeartbeat=this.now()
            else if(authenticated && packet.operation===5)this.receive(JSON.parse(packet.body.toString()))
          }
        } catch(error){finish(fault(error.code==='credentials'?'credentials':'protocol'))}
      })
    })
  }
  receive(event) {
    if(event?.cmd!=='LIVE_OPEN_PLATFORM_DM')return
    this.received++;this.lastMessageAt=this.now()
    const message=normalizeBiliDanmaku(event,this.roomId,this.now())
    if(this.now()-this.windowAt>=1000){this.windowAt=this.now();this.windowCount=0}
    // Bound scene/UI work before messages reach the model scheduler.
    if(!message || ++this.windowCount>30){this.dropped++;return}
    if(this.onMessage(message))this.accepted++;else this.dropped++
  }
}
