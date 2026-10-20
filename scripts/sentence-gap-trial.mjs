import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SpeechOutput } from '../apps/cohost/speech-output.mjs'
import { chunkTtsInput } from '../vendor/airi/packages/pipelines-audio/dist/index.mjs'

// Real cloud PCM arrivals with fixed text. Playback times are estimates, not speaker measurements.
const headers = process.env.COHOST_ACCESS_TOKEN ? { Authorization: 'Bearer ' + process.env.COHOST_ACCESS_TOKEN } : {}
const response = await fetch('http://127.0.0.1:8787/api/speech/config', { headers })
if (!response.ok) throw Error('Cannot read the current voice')
const { effective } = await response.json()
if (effective.engine !== 'qwen') throw Error('This trial requires the current Qwen voice')
const text = '这只猫也太会享受生活了，跑步机直接变成了它的专属猫窝。你下次跑步之前，是不是还得先跟猫老板申请一下？'
const directory = resolve('data/sentence-gap-trial-' + Date.now())
mkdirSync(directory)
const report = { kind: 'real-cloud-fixed-text-estimated-playback-no-ASR-no-LLM', model: effective.model, text, trials: [] }
for (const mode of ['serial-fragments', 'parallel-sentences']) {
  const output = new SpeechOutput({ engine: effective.engine, voice: effective.voice })
  const trial = { mode, segments: [] }
  report.trials.push(trial)
  try {
    await output.prepare()
    const start = performance.now(), elapsed = () => performance.now() - start
    let tail = Promise.resolve()
    const tasks = []
    const options = mode === 'serial-fragments' ? { preserveSourceText: true } : { preserveSourceText: true, boost: 0, maximumWords: 24 }
    for await (const chunk of chunkTtsInput(text, options)) {
      const segment = { text: chunk.text, frames: [] }
      trial.segments.push(segment)
      const run = async () => {
        segment.requestAt = elapsed()
        await output.stream(chunk.text, { emit: event => {
          if (event.type === 'audio') segment.frames.push({ at: elapsed(), durationMs: Buffer.from(event.pcm, 'base64').length / (event.sampleRate * 2) * 1000 })
        } })
        segment.doneAt = elapsed()
      }
      const task = mode === 'serial-fragments' ? tail.then(run) : run()
      tail = task
      tasks.push(task)
    }
    const results = await Promise.allSettled(tasks)
    if (results.some(result => result.status === 'rejected')) throw Error('Cloud synthesis failed')
    let cursor = 0
    trial.estimatedBoundaryGapsMs = []
    for (const segment of trial.segments) {
      const previousEnd = cursor
      for (let i = 0; i < segment.frames.length; i++) {
        // AIRI retains one PCM frame until the next frame or stream completion.
        const ready = segment.frames[i + 1]?.at ?? segment.doneAt
        cursor = Math.max(cursor, ready)
        if (i === 0) segment.estimatedStartAt = cursor
        cursor += segment.frames[i].durationMs
      }
      if (previousEnd) trial.estimatedBoundaryGapsMs.push(segment.estimatedStartAt - previousEnd)
      segment.estimatedEndAt = cursor
    }
  } catch {
    trial.error = 'Cloud trial failed; partial timings retained and excluded from conclusions'
    process.exitCode = 1
  } finally {
    output.close()
    writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify({ mode, segments: trial.segments.map(s => s.text), gaps: trial.estimatedBoundaryGapsMs, error: trial.error }))
}
console.log('Evidence: ' + directory)
