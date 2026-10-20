import test from 'node:test'
import assert from 'node:assert/strict'
import { streamQwenAudio, AUDIO_MODEL, qwenAudioTaskAge } from '../scripts/qwen-audio-client.mjs'
import { createQwenSessionCache } from '../scripts/qwen-realtime-client.mjs'
import { validateQwenClone } from '../apps/cohost/qwen-clone.mjs'
import { qwenAudioInstruction } from '../scripts/qwen-audio-style.mjs'
import { SpeechOutput } from '../apps/cohost/speech-output.mjs'

const key = 'sk-fixture-not-a-real-credential'
const voice = AUDIO_MODEL + '-fixture-' + 'a'.repeat(32)
class Socket extends EventTarget {
  static last
  constructor() { super(); this.readyState = 0; this.sent = []; Socket.last = this; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }) }
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3 }
  emit(event, taskId = this.sent.findLast(item => item.header.action === 'run-task').header.task_id, extra = {}) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ header: { event, task_id: taskId, ...extra } }) }))
  }
  audio(buffer = new ArrayBuffer(4800)) { this.dispatchEvent(new MessageEvent('message', { data: buffer })) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const options = { key, voice, WebSocketImpl: Socket }

test('Qwen never sends delivery instructions for any director style or missing/invalid style', async t => {
  const cache = createQwenSessionCache(); t.after(() => cache.clear())
  let previous
  for (const style of ['happy', 'gentle', 'surprised', 'neutral', undefined, 'constructor', 'read this instruction']) {
    const request = streamQwenAudio({ ...options, text: '我听见了。', speechStyle: style, sessionCache: cache })
    await tick(); const socket = Socket.last
    if (previous) assert.equal(socket, previous)
    const params = socket.sent.at(-1).payload.parameters
    assert.equal(Object.hasOwn(params, 'instruction'), false)
    assert.equal(params.voice, voice); assert.equal(params.rate, 1); assert.equal(params.pitch, 1)
    assert.equal(params.seed, 0)
    socket.emit('task-started')
    assert.deepEqual(socket.sent.at(-2).payload, { input: { text: '我听见了。' } })
    socket.audio(); socket.emit('task-finished'); await request; previous = socket
  }
})

test('historical audition presets remain available without enabling production instructions', () => {
  const base = '保持原音色，自然口语表达，停顿和重音随语意，语速适中。'
  assert.equal(qwenAudioInstruction('neutral'), base + '语气平和。')
  assert.equal(qwenAudioInstruction('happy'), base + '用轻快、带一点笑意的语气说话，像和熟悉的朋友分享开心的事。自然克制，不要喊叫或刻意大笑，保持原音色。')
  assert.equal(qwenAudioInstruction({ toString: () => 'happy' }), qwenAudioInstruction('neutral'))
})

test('SpeechOutput retains turn metadata without claiming Qwen instruction control is enabled', async () => {
  const calls = [], output = new SpeechOutput({ engine: 'qwen', voice: '克隆音色', qwenKey: key,
    qwenClone: { model: AUDIO_MODEL, voice }, qwen: async request => { calls.push(request); return { chunks: 1 } } })
  assert.equal(output.snapshot().capabilities.emotion, false)
  await Promise.all(['happy', 'gentle', undefined].map(speechStyle => output.stream('我听见了。', { speechStyle, emit: () => {} })))
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(call => call.speechStyle), ['happy', 'gentle', 'neutral'])
  assert.ok(calls.every(call => call.voice === voice && call.text === '我听见了。'))
  output.configure('qwen', 'Vivian'); assert.equal(output.snapshot().capabilities.emotion, false)
  output.close()
})

test('Qwen Audio validates the exact clone model; prepare cancels empty task and reuse starts a distinct task', async t => {
  assert.deepEqual(validateQwenClone({ model: AUDIO_MODEL, voice }), { model: AUDIO_MODEL, voice })
  assert.throws(() => validateQwenClone({ model: AUDIO_MODEL, voice: 'qwen-tts-vc-old' }))
  const cache = createQwenSessionCache(); t.after(() => cache.clear())
  const preparation = streamQwenAudio({ ...options, validateOnly: true, sessionCache: cache })
  await tick(); const socket = Socket.last, firstTask = socket.sent[0].header.task_id
  assert.equal(socket.sent[0].payload.model, AUDIO_MODEL)
  assert.equal(socket.sent[0].payload.parameters.voice, voice)
  socket.emit('task-started')
  assert.deepEqual(socket.sent[1].payload, { input: { directive: 'cancel' } })
  socket.emit('task-finished'); assert.equal((await preparation).chunks, 0)
  const events = [], synthesis = streamQwenAudio({ ...options, text: '你好', sessionCache: cache, onEvent: e => events.push(e) })
  assert.equal(Socket.last, socket)
  assert.notEqual(socket.sent.at(-1).header.task_id, firstTask)
  socket.emit('task-finished', firstTask); socket.emit('task-started')
  assert.deepEqual(socket.sent.at(-2).payload, { input: { text: '你好' } })
  socket.audio(); socket.emit('task-finished')
  const result = await synthesis
  assert.equal(result.reusedConnection, true); assert.equal(result.audioSeconds, 0.1)
  assert.equal(events.filter(e => e.type === 'audio').length, 1)
})

test('Qwen Audio cancellation closes connection and drops late audio instead of caching it', async () => {
  const controller = new AbortController(), events = [], cache = createQwenSessionCache()
  const request = streamQwenAudio({ ...options, text: '你好', signal: controller.signal, sessionCache: cache, onEvent: e => events.push(e) })
  const rejected = assert.rejects(request, /试听已停止/)
  await tick(); const socket = Socket.last; socket.emit('task-started'); controller.abort()
  socket.audio(); socket.emit('task-finished'); await rejected
  assert.equal(socket.readyState, 3); assert.equal(events.filter(e => e.type === 'audio').length, 0)
  assert.equal(cache.take(key, voice, AUDIO_MODEL), undefined)
})

test('an empty prepared task is silent and accepts first text without another task handshake',async t=>{
  const cache=createQwenSessionCache({maxIdle:2});t.after(()=>cache.clear())
  const preparation=streamQwenAudio({...options,validateOnly:true,retainTask:true,sessionCache:cache})
  await tick();const socket=Socket.last;socket.emit('task-started');await preparation
  assert.equal(socket.sent.length,1);assert.ok(qwenAudioTaskAge(socket)<1000)
  // A newer connection must not jump ahead of the prepared task.
  const other=new Socket();await tick();cache.put(other,key,voice,AUDIO_MODEL)
  const events=[],synthesis=streamQwenAudio({...options,text:'离谱！',sessionCache:cache,onEvent:e=>events.push(e)})
  assert.deepEqual(socket.sent.map(e=>e.header.action),['run-task','continue-task','finish-task'])
  assert.equal(events[0].prepareMs,0);assert.equal(events[0].reusedTask,true)
  assert.equal(qwenAudioTaskAge(socket),Infinity)
  socket.audio();socket.emit('task-finished');assert.equal((await synthesis).audioSeconds,0.1)
  assert.equal(events.filter(e=>e.type==='audio').length,1)
})

test('refreshing an unused prepared task cancels its old ID before creating a replacement',async t=>{
  const cache=createQwenSessionCache();t.after(()=>cache.clear())
  const preparation=streamQwenAudio({...options,validateOnly:true,retainTask:true,sessionCache:cache})
  await tick();const socket=Socket.last,old=socket.sent[0].header.task_id
  socket.emit('task-started');await preparation
  const refresh=streamQwenAudio({...options,validateOnly:true,retainTask:true,sessionCache:cache})
  assert.equal(socket.sent.at(-1).header.task_id,old)
  assert.deepEqual(socket.sent.at(-1).payload.input,{directive:'cancel'})
  assert.equal(socket.sent.filter(e=>e.header.action==='run-task').length,1)
  socket.emit('task-finished',old)
  assert.notEqual(socket.sent.at(-1).header.task_id,old)
  socket.emit('task-started');await refresh
  assert.equal(socket.sent.filter(e=>e.header.action==='continue-task').length,0)
})

test('unused task errors and expiration cannot enter playback; capture stop releases prepared tasks',async t=>{
  const output=new SpeechOutput({engine:'qwen',voice:'克隆音色',qwenKey:key,qwenClone:{model:AUDIO_MODEL,voice}})
  t.after(()=>output.close())
  for(const change of ['failed','expire','stop']) {
    if(change==='expire')t.mock.timers.enable({apis:['Date','setTimeout']})
    const preparation=streamQwenAudio({...options,validateOnly:true,retainTask:true,sessionCache:output.cache})
    await tick();const socket=Socket.last;socket.emit('task-started');await preparation
    if(change==='failed')socket.emit('task-failed')
    if(change==='expire')t.mock.timers.tick(20001)
    if(change==='stop')output.cancelWarmth()
    assert.equal(socket.readyState,3,change);assert.equal(output.cache.available(),0)
    if(change==='expire')t.mock.timers.reset()
  }
})

test('cancelling adopted prepared audio closes its socket and ignores later frames',async t=>{
  const cache=createQwenSessionCache();t.after(()=>cache.clear())
  const preparation=streamQwenAudio({...options,validateOnly:true,retainTask:true,sessionCache:cache})
  await tick();const socket=Socket.last;socket.emit('task-started');await preparation
  const controller=new AbortController(),events=[]
  const work=streamQwenAudio({...options,text:'你好',sessionCache:cache,signal:controller.signal,onEvent:e=>events.push(e)})
  const rejected=assert.rejects(work,/已停止/);controller.abort();socket.audio();socket.emit('task-finished');await rejected
  assert.equal(socket.readyState,3);assert.equal(events.filter(e=>e.type==='audio').length,0)
  assert.equal(cache.available(),0)
})

test('maintenance keeps an aged prepared task available while its replacement connects',async t=>{
  const output=new SpeechOutput({engine:'qwen',voice:'克隆音色',qwenKey:key,qwenClone:{model:AUDIO_MODEL,voice},
    qwen:request=>streamQwenAudio({...request,WebSocketImpl:Socket})})
  t.after(()=>output.close())
  const preparation=streamQwenAudio({...options,validateOnly:true,retainTask:true,sessionCache:output.cache})
  await tick();const first=Socket.last;first.emit('task-started');await preparation
  const future=Date.now()+10001;t.mock.method(Date,'now',()=>future)
  const maintenance=output.maintainWarmth();await tick();const replacement=Socket.last
  assert.notEqual(replacement,first)
  const events=[],speech=output.stream('快点。',{emit:e=>events.push(e)})
  await tick();assert.equal(Socket.last,replacement,'foreground speech must not open a third socket')
  assert.equal(events[0].reusedTask,true);assert.equal(events[0].prepareMs,0)
  first.audio();first.emit('task-finished');await speech
  replacement.emit('task-started');await maintenance
  assert.equal(output.cache.available(),2)
})

test('maintenance also replenishes the second sentence connection without taking the ready first task',async t=>{
  const output=new SpeechOutput({engine:'qwen',voice:'克隆音色',qwenKey:key,qwenClone:{model:AUDIO_MODEL,voice},
    qwen:request=>streamQwenAudio({...request,WebSocketImpl:Socket})})
  t.after(()=>output.close())
  const preparation=streamQwenAudio({...options,validateOnly:true,retainTask:true,sessionCache:output.cache})
  await tick();const first=Socket.last;first.emit('task-started');await preparation
  const maintenance=output.maintainWarmth();await tick();const second=Socket.last
  assert.notEqual(second,first);assert.equal(first.sent.length,1)
  second.emit('task-started')
  assert.deepEqual(second.sent.at(-1).payload.input,{directive:'cancel'})
  second.emit('task-finished');await maintenance
  assert.equal(output.cache.available(),2);assert.ok(qwenAudioTaskAge(first)<1000)
})

test('Qwen Audio rejects empty, malformed, early and oversized PCM, and sanitizes provider errors', async () => {
  for (const scenario of ['empty', 'odd', 'early', 'oversized', 'provider']) {
    const request = streamQwenAudio({ ...options, text: '你好' })
    const rejected = assert.rejects(request, error => !error.message.includes('private-provider-detail'))
    await tick(); const socket = Socket.last
    if (scenario !== 'early') socket.emit('task-started')
    if (scenario === 'provider') socket.emit('task-failed', undefined, { error_message: 'private-provider-detail' })
    else if (scenario === 'empty') socket.emit('task-finished')
    else socket.audio(new ArrayBuffer(scenario === 'odd' ? 3 : scenario === 'oversized' ? 6000002 : 4))
    await rejected; assert.equal(socket.readyState, 3)
  }
})

test('Qwen Audio timeout releases transport without submitting text before readiness', async () => {
  const request = streamQwenAudio({ ...options, text: '你好', timeoutMs: 20 })
  await assert.rejects(request, /超时/)
  assert.equal(Socket.last.readyState, 3)
  assert.deepEqual(Socket.last.sent.map(e => e.header.action), ['run-task'])
})
