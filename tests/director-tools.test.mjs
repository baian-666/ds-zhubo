import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DirectorTools, publicWebUrl } from '../apps/cohost/director-tools.mjs'
import { streamParticipation } from '../apps/cohost/participation-stream.mjs'

function remote(t,handler,options={}) {
  const servers=[]
  const owner=new DirectorTools({...options,webTransport:()=>{
    const server=new Server({name:'test-search',version:'1'},{capabilities:{tools:{}}})
    const pair=InMemoryTransport.createLinkedPair();servers.push(server)
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['web_search_exa','web_fetch_exa'].map(name=>({name,inputSchema:{type:'object'}}))}))
    server.setRequestHandler(CallToolRequestSchema,handler)
    void server.connect(pair[1]);return pair[0]
  }})
  t.after(async()=>{owner.close();await Promise.allSettled(servers.map(server=>server.close()))})
  return owner
}
const text=value=>({content:[{type:'text',text:value}]})

test('local live context goes through MCP discovery and execution without opening a web connection',async t=>{
  let web=0,live=1
  const owner=new DirectorTools({webTransport:()=>{web++;throw Error('must not connect')}})
  t.after(()=>owner.close())
  const session=owner.session({characterId:'whale',readLive:()=>({topic:live})})
  const a=await session.call('live_context',{});live=2
  const b=await session.call('live_context',{})
  assert.equal(JSON.parse(a.content).topic,1);assert.equal(JSON.parse(b.content).topic,2)
  assert.equal(web,0);assert.equal(owner.status('whale').connections[0].state,'ready')
  assert.equal(owner.status('other').recent.length,0)
  await session.close();assert.equal(owner.sessions.size,0)
})

test('search and page reading call discovered MCP tools with bounded arguments and preserve sources',async t=>{
  const calls=[],owner=remote(t,async request=>{calls.push(request.params);return text('Source: https://www.iau.org/public/themes/pluto/\nA dwarf planet.')})
  const session=owner.session({characterId:'whale'})
  assert.equal((await session.call('web_search',{query:'Pluto official classification'})).ok,true)
  assert.equal((await session.call('web_read',{url:'https://www.iau.org/public/themes/pluto/'})).ok,true)
  assert.deepEqual(calls.map(item=>item.name),['web_search_exa','web_fetch_exa'])
  assert.equal(calls[0].arguments.numResults,4);assert.equal(calls[1].arguments.maxCharacters,6000)
  assert.equal(owner.status('whale').recent[0].sources[0].url,'https://www.iau.org/public/themes/pluto/')
  await session.close()
})

test('only offered public URLs are readable; private addresses, unknown tools and excess calls are rejected',async t=>{
  let calls=0;const owner=remote(t,async()=>{calls++;return text('page')})
  const session=owner.session({urls:['https://www.iau.org/public/']})
  assert.equal((await session.call('web_read',{url:'https://www.iau.org/other/'})).ok,false)
  assert.equal((await session.call('web_read',{url:'http://127.0.0.1:8787/api/status'})).ok,false)
  assert.equal((await session.call('web_read',{url:'https://www.iau.org/public/'})).ok,true)
  await assert.rejects(session.call('web_search',{query:'fourth'}),/budget/)
  assert.equal(calls,1)
  for(const url of ['file:///etc/passwd','http://localhost/','http://2130706433/','http://[::1]/','http://user:pass@www.iau.org/','https://office.internal/','javascript:alert(1)'])assert.equal(publicWebUrl(url),null,url)
  const fresh=owner.session();await assert.rejects(fresh.call('shell',{}),/Unknown/)
})

test('failed, oversized, cancelled and reset tool results have bounded, truthful receipts',async t=>{
  const owner=remote(t,async request=>request.params.arguments.query==='fail'?{isError:true,...text('secret diagnostic')}:
    request.params.arguments.query==='slow'?(await delay(70),text('late')):text('x'.repeat(20000)))
  let session=owner.session({characterId:'whale'})
  const failed=await session.call('web_search',{query:'fail'})
  assert.equal(failed.ok,false);assert.doesNotMatch(JSON.stringify(owner.status('whale')),/secret diagnostic/)
  const long=await session.call('web_search',{query:'long'})
  assert.equal(long.content.length,10000);assert.equal(owner.status('whale').recent[0].summary.length,1000)
  const controller=new AbortController();session=owner.session({characterId:'whale',signal:controller.signal})
  const pending=session.call('web_search',{query:'slow'}),rejected=assert.rejects(pending)
  await delay(10);controller.abort();await rejected;await delay(80)
  assert.equal(owner.status('whale').recent[0].state,'cancelled')
  owner.reset();assert.equal(owner.status('whale').recent.length,0)
})

function response(name,args,{finish='tool_calls',id='call-1'}={}) {
  const frames=[{choices:[{index:0,delta:{tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]},
    {choices:[{index:0,delta:{},finish_reason:finish}]}]
  return new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n')
}
const decision={kind:'decision',action:'reply_host',hostIntent:'invited',reason:'核实后回答',text:'资料显示冥王星属于矮行星。',targetId:'',platform:''}

test('end-of-speech preparation can request research but defers execution until final ASR',async()=>{
  let requests=0
  const result=await streamParticipation({answerPreparation:true,endOfSpeechPreparation:true},{
    information:{call(){assert.fail('provisional words cannot execute an information query')}},
    fetchImpl:async(_url,options)=>{
      requests++;assert.equal(JSON.parse(options.body).tools.length,4)
      return response('web_search',{query:'unconfirmed topic'})
    },
  })
  assert.equal(requests,1);assert.equal(result.action,'wait');assert.equal(result.replyStream,undefined)
})

test('the model chooses MCP search then page reading, followed by the existing streamed answer',async()=>{
  const requests=[],calls=[];let rounds=0,lookups=0
  const information={call:async(name,args)=>{calls.push({name,args});return {ok:true,untrustedData:true,content:'Reference data'}}}
  const result=await streamParticipation({}, {information,onLookup:()=>lookups++,fetchImpl:async(url,options)=>{
    requests.push(JSON.parse(options.body));rounds++
    if(rounds===1)return response('web_search',{query:'Pluto'})
    if(rounds===2)return response('web_read',{url:'https://www.iau.org/'})
    return response('participate',{records:[decision,{kind:'speech',text:'这是国际天文学联合会的分类。'}]})
  }})
  const records=[];for await(const record of result.replyStream)records.push(record)
  assert.equal(records.length,2);assert.equal(lookups,2)
  assert.deepEqual(calls.map(item=>item.name),['web_search','web_read'])
  assert.equal(requests[1].messages.at(-1).role,'tool');assert.equal(requests[1].messages.at(-1).tool_call_id,'call-1')
  assert.equal(requests[0].tools.length,4)
})

test('ordinary speech still starts before the provider finishes without any MCP call or extra model request',async()=>{
  let writer,requests=0
  const body=new ReadableStream({start(c){writer=c}})
  const pending=streamParticipation({}, {information:{call(){assert.fail('ordinary chat cannot query')}},fetchImpl:async()=>{requests++;return new Response(body)}})
  writer.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'first',type:'function',function:{name:'participate',arguments:'{"records":['+JSON.stringify(decision)}}]},finish_reason:null}]})+'\n\n'))
  const result=await pending
  assert.equal(result.text,decision.text);assert.equal(requests,1);result.replyStream.close()
})

test('three lookups force a final decision; floor/listening/preparation never offer information tools',async()=>{
  let rounds=0,calls=0
  const result=await streamParticipation({}, {information:{call:async()=>{calls++;return {ok:false,error:'unavailable'}}},fetchImpl:async(url,options)=>{
    const request=JSON.parse(options.body);rounds++
    if(rounds<=3)return response('web_search',{query:'try'})
    assert.equal(request.tools.length,1);assert.equal(request.tool_choice.function.name,'participate')
    return response('participate',{records:[decision]})
  }})
  result.replyStream.close();assert.equal(calls,3)
  for(const key of ['floorOpportunity','listeningOpportunity','answerPreparation','active']) {
    await assert.rejects(streamParticipation({[key]:true},{information:{call(){assert.fail()}},fetchImpl:async(url,options)=>{
      assert.equal(JSON.parse(options.body).tools.length,1);return response('web_search',{query:'unexpected'})
    }}),/tool/)
  }
})

test('truncated or multi-tool provider output never executes a partial MCP call',async()=>{
  let calls=0
  await assert.rejects(streamParticipation({}, {information:{call(){calls++}},fetchImpl:async()=>response('web_search',{query:'partial'},{finish:'length'})}),/truncated/)
  assert.equal(calls,0)
})
