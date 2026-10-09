import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Director } from '../apps/cohost/director.mjs'
import { Scheduler } from '../apps/cohost/scheduler.mjs'

const scenarios = JSON.parse(readFileSync(new URL('../tests/fixtures/director-replay.json', import.meta.url), 'utf8'))
const durations = []
for (let iteration = 0; iteration < 1000; iteration++) {
  for (const scenario of scenarios) {
    let time = 0
    const scheduler = new Scheduler({ now: () => time })
    const director = new Director({ scheduler, now: () => time })
    if (scenario.seedReply) scheduler.beginHost(scenario.seedReply)
    for (const event of scenario.events) {
      time = event.at ?? time
      director.event(event)
      durations.push(director.lastEventMs)
    }
    const actual = { candidate: Boolean(director.status().candidate), busy: scheduler.status().busy, intent: director.status().intent }
    assert.deepEqual(actual, scenario.expect, scenario.name)
    if (iteration === 0) console.log(`${scenario.name}: ${JSON.stringify(actual)}`)
    director.close()
  }
}
durations.sort((a, b) => a - b)
const percentile = p => Number(durations[Math.min(durations.length - 1, Math.floor(durations.length * p))].toFixed(3))
console.log(JSON.stringify({ events: durations.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) }))
console.log('仅测本机同步导演事件；不包含 ASR、语义服务、模型、TTS、网络或实际播放延迟。没有调用 API。')
