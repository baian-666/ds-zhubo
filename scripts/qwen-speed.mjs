// Bounded real-cloud timing via the configured local trial service. No keys read.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'data/qwen-audition/speed-20261013')
if (existsSync(output)) throw new Error('Choose a fresh timing directory before rerunning')
mkdirSync(output)
const base = 'http://127.0.0.1:8792'
const page = await (await fetch(base)).text()
const token = page.match(/name="csrf" content="([^"]+)"/)[1]
const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Setup-Token': token }
const cases = {
  short: '我在听，你继续。',
  medium: '你来啦，今天有什么好玩的事情？',
  long: '等等，这个梗我接住了。你是不是又偷偷摸鱼了？别急，我先听你把故事讲完，再来帮你接下一句。',
  conversation: '你来啦，今天有什么好玩的事情？等等，这个梗我接住了。你是不是又偷偷摸鱼了？',
}
const voice = 'Vivian'
const report = { kind: 'Real Qwen cloud PCM arrival via local HTTP; no playback/ASR/LLM', voice, trials: [] }
const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const prepared = await fetch(base + '/prepare', { method: 'POST', headers, body: JSON.stringify({ voice }) })
if (!prepared.ok) throw new Error('Local preconnection failed; no timing trial started')
for (let repeat = 0; repeat < 3; repeat++) {
  for (const [name, text] of Object.entries(cases)) {
    const start = performance.now(), chunks = []
    const response = await fetch(base + '/trial', { method: 'POST', headers, body: JSON.stringify({ text, voice }) })
    if (!response.ok) throw new Error('Local trial failed; see trial page')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let pending = '', first = null, voiced = null, result = null
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const event = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1)
        if (event.type === 'error') throw new Error('Cloud trial failed; no partial timing counted')
        if (event.type === 'done') result = event
        if (event.type !== 'audio') continue
        first ??= performance.now() - start
        const pcm = Buffer.from(event.pcm, 'base64'); chunks.push(pcm)
        const frame = 240
        for (let i = 0; i + frame * 2 <= pcm.length && voiced === null; i += frame * 2) {
          let sum = 0
          for (let j = i; j < i + frame * 2; j += 2) sum += (pcm.readInt16LE(j) / 32768) ** 2
          if (Math.sqrt(sum / frame) >= 10 ** (-45 / 20)) voiced = performance.now() - start
        }
      }
    }
    if (!result || !chunks.length || voiced === null) throw new Error('No validated active audio')
    const pcm = Buffer.concat(chunks), header = Buffer.alloc(44)
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
    const file = `${name}-${repeat + 1}.wav`
    writeFileSync(resolve(output, file), Buffer.concat([header, pcm]))
    const trial = { name, repeat: repeat + 1, text, file, firstPcmMs: first, firstActiveChunkMs: voiced, ...result }
    // Keep distinct client arrival and server-side transport timings.
    trial.clientFirstPcmMs = first; trial.clientFirstActiveChunkMs = voiced
    report.trials.push(trial); save()
    console.log(JSON.stringify({ name, repeat: repeat + 1, clientFirstPcmMs: first, synthesisFirstPcmMs: result.synthesisFirstPcmMs, reused: result.reusedConnection }))
  }
}
report.complete = true; save()
