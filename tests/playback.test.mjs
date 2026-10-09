import test from 'node:test'
import assert from 'node:assert/strict'
import { Scheduler } from '../apps/cohost/scheduler.mjs'

function setup() {
  let time = 0
  const scheduler = new Scheduler({ now: () => time })
  const heard = []
  scheduler.onDelivered = (input, text) => heard.push(text)
  const turn = scheduler.beginHost('你好')
  turn.delivery = 'audio'
  turn.answer = '第一句。第二句。'
  const event = (event, playedChars) => scheduler.playbackEvent({ turn: turn.id, audioId: turn.audioId, event, playedChars })
  return { scheduler, turn, heard, event, advance: ms => { time += ms } }
}

test('generation done does not finish an audio turn or commit unheard text', () => {
  const s = setup()
  s.scheduler.finish(s.turn)
  assert.equal(s.scheduler.status().busy, true)
  assert.equal(s.scheduler.status().generating, false)
  assert.deepEqual(s.heard, [])
  assert.equal(s.event('ended', 8), false)
  assert.equal(s.event('started'), true)
  assert.equal(s.event('ended', 8), true)
  assert.deepEqual(s.heard, ['第一句。第二句。'])
  assert.equal(s.scheduler.status().busy, false)
})

test('playback gate denies host overlap and old audio, acknowledgment allows ongoing progress', () => {
  const s = setup()
  s.scheduler.observeHostSpeaking(true)
  assert.equal(s.event('started'), false)
  s.scheduler.observeHostSpeaking(false)
  assert.equal(s.event('started'), true)
  assert.equal(s.event('started'), false)
  s.scheduler.observeHostSpeaking(true)
  assert.equal(s.event('progress', 4), true)
  s.scheduler.interrupt()
  assert.deepEqual(s.heard, ['第一句。'])
  assert.equal(s.event('progress', 8), false)
  assert.equal(s.event('started'), false)
})

test('invalid, regressing, premature or mismatched playback reports do not commit text', () => {
  const s = setup()
  assert.equal(s.event('progress', 4), false)
  assert.equal(s.scheduler.playbackEvent({ turn: s.turn.id, audioId: 'wrong', event: 'started' }), false)
  s.event('started')
  assert.equal(s.event('progress', 9), false)
  assert.equal(s.event('progress', 4), true)
  assert.equal(s.event('progress', 3), false)
  assert.equal(s.event('ended', 8), false)
  s.scheduler.finish(s.turn)
  assert.equal(s.event('ended', 4), false)
  assert.equal(s.event('stopped', 4), true)
  assert.deepEqual(s.heard, ['第一句。'])
  assert.equal(s.event('stopped', 4), false)
})

test('missing playback heartbeat expires turn without committing unplayed text', () => {
  const s = setup()
  s.scheduler.finish(s.turn)
  s.advance(15000)
  assert.equal(s.scheduler.status().busy, false)
  assert.equal(s.turn.controller.signal.aborted, true)
  assert.deepEqual(s.heard, [])
  assert.equal(s.event('started'), false)
})

test('mute cancels audio and later text turn sees only acknowledged prefix once', () => {
  const s = setup()
  s.event('started'); s.event('progress', 4)
  s.scheduler.setMuted(true)
  s.scheduler.finish(s.turn)
  assert.deepEqual(s.heard, ['第一句。'])
  assert.equal(s.scheduler.beginHost('继续'), null)
})

test('acknowledgment cannot split a Unicode surrogate pair', () => {
  const s = setup()
  s.turn.answer = '好😀呀'
  s.event('started')
  assert.equal(s.event('progress', 2), false)
  assert.equal(s.event('stopped', 3), true)
  assert.deepEqual(s.heard, ['好😀'])
})
