import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { RoomJournal } from '../apps/cohost/room-journal.mjs'
import { createApp } from '../apps/cohost/server.mjs'

test('display journal is bounded, snapshots are detached, and reset isolates old streams', () => {
  const room = new RoomJournal({ limit: 3, now: () => 123 })
  const old = room.add('assistant', '旧回复')
  const session = room.session
  room.add('viewer', 'a'); room.add('viewer', 'b'); room.add('viewer', 'c')
  assert.equal(room.entries.length, 3)
  assert.equal(room.update(old, { text: '迟到' }), null)
  const snapshot = room.status(); snapshot.entries[0].text = '外部修改'
  assert.equal(room.entries[0].text, 'a')
  room.clear(); assert.notEqual(room.session, session)
  assert.equal(room.update(old, { text: '迟到' }), null)
  assert.deepEqual(room.entries, [])
})
async function serve(t, options = {}) {
  const server = createApp({ apiKey: 'test-only', token: '', ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = 'http://127.0.0.1:' + server.address().port
  return {
    post: (path, body) => fetch(base + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    state: async () => (await fetch(base + '/api/status')).json(),
  }
}

test('local display recovery preserves bubbles without reviving audio, old utterances or model memory',async t=>{
 const original=new RoomJournal()
 original.host('上一场发言',1);original.add('assistant','未播完的文字',{status:'speaking',turn:12,engine:'deepseek'})
 const snapshot=original.status()
 const restored=new RoomJournal({snapshot})
 assert.notEqual(restored.session,snapshot.session)
 assert.equal(restored.entries[1].status,'cancelled');assert.equal(restored.entries[0].utterance,undefined)
 assert.equal(restored.entries[1].turn,undefined);assert.equal(snapshot.entries[1].status,'speaking')
 assert.equal(restored.add('host','新发言').id,3)
 let calls=0
 const r=await serve(t,{roomSnapshot:snapshot,reply:async function*({history,scene}){calls++;assert.equal(history.length,0);assert.ok(!scene.some(x=>x.text==='上一场发言'));yield '新回答'}})
 const state=await r.state();assert.equal(state.busy,false);assert.equal(state.airi.active,false);assert.equal(state.room.entries.length,2)
 await (await r.post('reply',{source:'host',engine:'deepseek',text:'新发言'})).text();assert.equal(calls,1)
 assert.throws(()=>new RoomJournal({snapshot:{entries:[{id:1,role:'unknown',text:''}]}}))
})
test('host comes before director, duplicate final is ignored, and streaming reply updates one bubble', async t => {
  const r = await serve(t, { reply: async function* () { yield '第一段'; yield '第二段' } })
  await r.post('director/event', { type: 'mode', value: 'auto' })
  await r.post('director/event', { type: 'speech-start', utterance: 1 })
  const transcript = { type: 'transcript', utterance: 1, text: '助播，你怎么看？', final: true }
  await r.post('director/event', transcript); await r.post('director/event', transcript)
  await r.post('director/event', { ...transcript, utterance: 9 })
  const end = await (await r.post('director/event', { type: 'speech-end', utterance: 1 })).json()
  const response = await r.post('reply', { source: 'director', decision: end.director.candidate.id })
  const events = (await response.text()).trim().split('\n').map(JSON.parse)
  const room = (await r.state()).room
  const hosts = room.entries.filter(x => x.role === 'host')
  assert.equal(hosts.length, 1)
  assert.ok(hosts[0].id < room.entries.find(x => x.reason === 'explicit_address').id)
  const answers = room.entries.filter(x => x.role === 'assistant')
  assert.equal(answers.length, 1)
  assert.equal(answers[0].text, '第一段第二段')
  assert.equal(answers[0].status, 'completed')
  assert.equal(new Set(events.map(x => x.entry.id)).size, 1)
  assert.ok(events.filter(x => x.type === 'delta').every(x => x.entry.revision > events[0].entry.revision))
})
test('manual reply does not duplicate submitted host; audience history survives queue consumption', async t => {
  const r = await serve(t, { reply: async function* () { yield '答复' } })
  await r.post('director/event', { type: 'speech-start', utterance: 1 })
  await r.post('director/event', { type: 'transcript', utterance: 1, text: '你好', final: true })
  await r.post('director/event', { type: 'speech-end', utterance: 1 })
  await (await r.post('reply', { source: 'host', text: '你好' })).text()
  const message = { id: 'v1', platform: 'manual', userId: '观众一', text: '<img src=x>', mentioned: true }
  await r.post('danmaku', message); await r.post('danmaku', message)
  await (await r.post('reply', { source: 'viewer' })).text()
  const state = await r.state()
  assert.equal(state.queued, 0)
  assert.equal(state.room.entries.filter(x => x.role === 'host').length, 1)
  assert.equal(state.room.entries.filter(x => x.role === 'viewer').length, 1)
  assert.equal(state.room.entries.find(x => x.role === 'viewer').text, message.text)
  assert.ok(state.room.entries.some(x => x.reason === 'manual_wait'))
})
test('cancelled and failed display fragments remain visible but cannot enter model history', async t => {
  let signalAbort
  const ready = new Promise(resolve => { signalAbort = resolve })
  const histories = []
  const r = await serve(t, { reply: async function* ({ input, signal, history }) {
    histories.push(history)
    if (input.text === '打断测试') {
      yield '已显示片段'
      signalAbort()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    } else if (input.text === '失败测试') { yield '失败片段'; throw new Error('private provider body') }
    else yield '新回复'
  } })
  const pending = r.post('reply', { source: 'host', text: '打断测试' }).then(r => r.text())
  await ready; await r.post('interrupt', {}); await pending
  await (await r.post('reply', { source: 'host', text: '失败测试' })).text()
  await (await r.post('reply', { source: 'host', text: '新问题' })).text()
  const answers = (await r.state()).room.entries.filter(x => x.role === 'assistant')
  assert.deepEqual(answers.map(x => x.status), ['cancelled', 'failed', 'completed'])
  assert.equal(answers[0].text, '已显示片段')
  assert.deepEqual(histories[2], [])
  assert.ok(!JSON.stringify(answers).includes('private provider body'))
})
test('reset clears displayed history and late completion cannot resurrect an old bubble', async t => {
  let notify
  const ready = new Promise(resolve => { notify = resolve })
  const r = await serve(t, { reply: async function* ({ signal }) {
    yield '旧文字'; notify()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  } })
  const before = (await r.state()).room.session
  const pending = r.post('reply', { source: 'host', text: '旧问题' }).then(r => r.text())
  await ready; await r.post('reset', {}); await pending
  const room = (await r.state()).room
  assert.notEqual(room.session, before)
  assert.equal(room.entries.length, 1)
  assert.equal(room.entries[0].reason, 'reset')
})
