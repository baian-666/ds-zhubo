import test from 'node:test'
import assert from 'node:assert/strict'
import { Scheduler } from '../apps/cohost/scheduler.mjs'

const message = (id, extra = {}) => ({ id, platform: 'bilibili', userId: id, text: '你怎么看？', mentioned: true, selected: false, ...extra })

test('host speech cancels generation and rejects stale completion', () => {
  const scheduler = new Scheduler()
  scheduler.enqueue(message('1'))
  const turn = scheduler.beginViewer()
  scheduler.setHostSpeaking(true)
  assert.equal(turn.controller.signal.aborted, true)
  assert.equal(scheduler.isCurrent(turn), false)
  assert.equal(scheduler.beginHost('继续'), null)
  scheduler.setHostSpeaking(false)
  const newTurn = scheduler.beginHost('现在回答')
  scheduler.finish(turn)
  assert.equal(scheduler.isCurrent(newTurn), true)
})

test('mute cancels current turn and suppresses all new turns', () => {
  const scheduler = new Scheduler()
  const turn = scheduler.beginHost('你好')
  scheduler.setMuted(true)
  assert.equal(turn.controller.signal.aborted, true)
  assert.equal(scheduler.beginHost('你好'), null)
  scheduler.enqueue(message('1'))
  assert.equal(scheduler.beginViewer(), null)
  scheduler.setMuted(false)
  assert.ok(scheduler.beginViewer())
})

test('deduplication includes platform and stale messages expire', () => {
  let now = 0
  const scheduler = new Scheduler({ now: () => now })
  assert.equal(scheduler.enqueue(message('1')), true)
  assert.equal(scheduler.enqueue(message('1')), false)
  assert.equal(scheduler.enqueue(message('1', { platform: 'wechat' })), true)
  now = 20_000
  assert.equal(scheduler.beginViewer(), null)
  assert.equal(scheduler.status().queued, 0)
})

test('selective replies, global cooldown, and per-viewer cooldown', () => {
  let now = 0
  const scheduler = new Scheduler({ now: () => now })
  scheduler.enqueue(message('ambient', { mentioned: false }))
  assert.equal(scheduler.beginViewer(), null)
  scheduler.enqueue(message('1', { userId: 'same' }))
  const first = scheduler.beginViewer()
  scheduler.finish(first)
  scheduler.enqueue(message('2'))
  assert.equal(scheduler.beginViewer(), null)
  now = 20_001
  scheduler.enqueue(message('3', { userId: 'same' }))
  scheduler.enqueue(message('4'))
  const second = scheduler.beginViewer()
  assert.equal(second.input.id, '4')
  scheduler.finish(second)
  now = 60_001
  scheduler.enqueue(message('5', { userId: 'same' }))
  assert.equal(scheduler.beginViewer().input.id, '5')
})

test('operator choice wins, host turn supersedes viewer, queue is bounded', () => {
  const scheduler = new Scheduler()
  for (let i = 0; i < 200; i++) scheduler.enqueue(message(String(i)))
  assert.equal(scheduler.status().queued, 128)
  scheduler.enqueue(message('selected', { selected: true }))
  const viewer = scheduler.beginViewer()
  assert.equal(viewer.input.id, 'selected')
  const host = scheduler.beginHost('先回答我')
  assert.equal(viewer.controller.signal.aborted, true)
  assert.equal(scheduler.isCurrent(host), true)
})
