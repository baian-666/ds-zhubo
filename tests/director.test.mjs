import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTick } from 'node:timers/promises'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'

function setup(options = {}) {
  let time = 0
  const scheduler = new Scheduler({ now: () => time })
  const director = new Director({ scheduler, now: () => time, ...options })
  director.event({ type: 'mode', value: 'auto' })
  const event = e => director.event(e)
  const start = id => event({ type: 'speech-start', utterance: id })
  const text = (id, text, final = true) => event({ type: 'transcript', utterance: id, text, final })
  const end = id => event({ type: 'speech-end', utterance: id })
  return { director, scheduler, event, start, text, end, advance: ms => { time += ms } }
}

test('explicit handover waits for end of speech but never awaits semantic classifier', () => {
  let classified = 0
  const s = setup({ classify: () => { classified++; return new Promise(() => {}) } })
  s.start(1)
  s.text(1, '助播，你怎么看？')
  assert.equal(s.director.status().candidate, null)
  s.advance(1000)
  const state = s.end(1)
  assert.ok(state.candidate)
  const turn = s.director.consume(state.candidate.id)
  assert.equal(turn.input.text, '助播，你怎么看？')
  assert.equal(classified, 0)
  assert.equal(s.director.consume(state.candidate.id), null)
})

test('mid-sentence pause and unfinished ASR do not grant a turn', () => {
  const s = setup()
  s.start(1)
  s.text(1, '助播，你觉得', false)
  s.end(1)
  s.advance(5000)
  assert.equal(s.director.status().candidate, null)
  s.start(2)
  s.text(2, '我这个问题先留到最后再说。')
  s.end(2)
  assert.equal(s.director.status().candidate, null)
})

test('VAD and short acknowledgment preserve active generation; semantic takeover cancels', () => {
  const s = setup()
  const turn = s.scheduler.beginHost('讲讲看')
  s.start(1)
  assert.equal(turn.controller.signal.aborted, false)
  s.text(1, '嗯，对', false)
  s.advance(250)
  s.text(1, '嗯，对')
  s.end(1)
  assert.equal(s.director.status().intent, 'backchannel')
  assert.equal(s.scheduler.isCurrent(turn), true)
  s.start(2)
  s.text(2, '对，但是我觉得要换个角度')
  s.event({ type: 'intent', revision: s.director.revision, intent: 'takeover', confidence: 0.95 })
  assert.equal(turn.controller.signal.aborted, true)
})

test('quoted stop phrase does not interrupt; exact command does', () => {
  const s = setup()
  const turn = s.scheduler.beginHost('继续')
  s.start(1)
  s.text(1, '他刚刚说等一下，然后走了。')
  assert.equal(s.scheduler.isCurrent(turn), true)
  s.end(1)
  s.start(2)
  s.text(2, '等一下！')
  assert.equal(turn.controller.signal.aborted, true)
})

test('expired or invalidated handover cannot start a reply', () => {
  const s = setup()
  s.start(1); s.text(1, '助播，你怎么看？')
  const id = s.end(1).candidate.id
  s.advance(2000)
  assert.equal(s.director.consume(id), null)
  s.start(2); s.text(2, '助播，你觉得呢？')
  const next = s.end(2).candidate.id
  s.start(3)
  assert.equal(s.director.consume(next), null)
})

test('topic changes invalidate semantic decisions and pending viewer playback', () => {
  const s = setup()
  s.scheduler.enqueue({ platform: 'manual', id: '1', userId: 'a', text: '旧话题', selected: true })
  const turn = s.scheduler.beginViewer()
  s.start(1); s.text(1, '这件事真有趣'); s.end(1)
  const revision = s.director.revision
  s.event({ type: 'topic-change' })
  assert.equal(turn.controller.signal.aborted, true)
  s.event({ type: 'intent', revision, intent: 'opportunity', confidence: 1 })
  assert.equal(s.director.status().candidate, null)
})

test('manual mode observes but never creates automatic replies; low-confidence intent waits', () => {
  const s = setup()
  s.event({ type: 'mode', value: 'manual' })
  s.start(1); s.text(1, '助播，你怎么看？'); s.end(1)
  assert.equal(s.director.status().candidate, null)
  s.event({ type: 'mode', value: 'auto' })
  s.start(2); s.text(2, '这真是个有趣的问题'); s.end(2)
  s.event({ type: 'intent', revision: s.director.revision, intent: 'opportunity', confidence: 0.5 })
  assert.equal(s.director.status().candidate, null)
  s.event({ type: 'intent', revision: s.director.revision, intent: 'opportunity', confidence: 0.95 })
  assert.equal(s.director.status().candidate.intent, 'opportunity')
})

test('late old utterance, duplicate final and invalid events cannot alter the current turn', () => {
  const s = setup()
  s.start(1); s.start(2)
  s.text(1, '停止回答')
  assert.equal(s.director.utterance.text, '')
  s.text(2, '助播，你怎么看？'); s.end(2)
  const candidate = s.director.status().candidate
  s.text(2, '停止回答')
  s.end(1)
  assert.equal(s.director.status().candidate.id, candidate.id)
  assert.throws(() => s.event({ type: 'speech-end' }), /utterance/)
  assert.throws(() => s.event({ type: 'intent', revision: 1, intent: 'stop', confidence: 5 }), /语义/)
})

test('semantic work coalesces to latest snapshot and rejects results from old speech', async () => {
  const jobs = []
  const s = setup({ classify: (snapshot, { signal }) => new Promise(resolve => jobs.push({ snapshot, signal, resolve })) })
  s.start(1); s.text(1, '第一个想法', false)
  await nextTick()
  for (let i = 0; i < 30; i++) s.text(1, `更新的想法${i}`, false)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].signal.aborted, true)
  jobs[0].resolve({ intent: 'stop', confidence: 1 })
  await nextTick()
  assert.equal(jobs.length, 2)
  assert.equal(jobs[1].snapshot.utterance.text, '更新的想法29')
  jobs[1].resolve({ intent: 'hold', confidence: 1 })
  await nextTick()
  assert.equal(s.director.status().intent, 'hold')
  s.director.close()
})

test('slow semantic adapter never blocks explicit handover; timeout result cannot take over', async () => {
  let resolve
  const s = setup({ semanticTimeoutMs: 1, classify: () => new Promise(r => { resolve = r }) })
  s.start(1); s.text(1, '一个模糊想法', false)
  await new Promise(r => setTimeout(r, 10))
  assert.ok(s.director.trace.some(x => x.reason === 'semantic_timeout'))
  s.start(2); s.text(2, '助播，你怎么看？')
  const candidate = s.end(2).candidate
  const turn = s.director.consume(candidate.id)
  resolve({ intent: 'stop', confidence: 1 })
  await nextTick()
  assert.equal(s.scheduler.isCurrent(turn), true)
})

test('proactive participation is budgeted; explicit handover bypasses that cooldown', () => {
  const s = setup()
  s.start(1); s.text(1, '这件事情挺有趣'); s.end(1)
  s.event({ type: 'intent', revision: s.director.revision, intent: 'opportunity', confidence: 1 })
  const first = s.director.consume(s.director.status().candidate.id)
  assert.equal(first.input.participation, 'opportunity')
  s.scheduler.finish(first)
  s.event({ type: 'intent', revision: s.director.revision, intent: 'opportunity', confidence: 1 })
  assert.equal(s.director.status().candidate, null)
  s.start(2); s.text(2, '又有个挺有趣的事情'); s.end(2)
  s.event({ type: 'intent', revision: s.director.revision, intent: 'opportunity', confidence: 1 })
  assert.equal(s.director.status().candidate, null)
  s.start(3); s.text(3, '助播，你怎么看？'); s.end(3)
  assert.ok(s.director.consume(s.director.status().candidate.id))
})

test('topic change drops queued old-topic comments, mute invalidates a pending decision', () => {
  const s = setup()
  s.scheduler.enqueue({ platform: 'manual', id: '1', userId: 'a', text: '旧话题', selected: true })
  s.event({ type: 'topic-change' })
  assert.equal(s.scheduler.beginViewer(), null)
  s.start(1); s.text(1, '助播，你怎么看？'); s.end(1)
  const id = s.director.status().candidate.id
  s.scheduler.setMuted(true)
  assert.equal(s.director.consume(id), null)
})

test('control reset during speech accepts its later end without resurrecting the old handover', () => {
  const s = setup()
  s.start(1); s.text(1, '助播，你怎么看？')
  s.director.reset('manual_interrupt')
  assert.equal(s.scheduler.hostSpeaking, true)
  s.end(1)
  assert.equal(s.scheduler.hostSpeaking, false)
  assert.equal(s.director.status().candidate, null)
  s.start(2)
  s.event({ type: 'topic-change' })
  s.end(2)
  assert.equal(s.scheduler.hostSpeaking, false)
})
