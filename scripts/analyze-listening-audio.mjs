import { readFileSync, writeFileSync } from 'node:fs'
const label = process.argv[2] || 'waveform-2'
const dir = 'data/listening-audio-trial/'
const report = JSON.parse(readFileSync(dir + label + '.json'))
const recording = JSON.parse(readFileSync(dir + label + '-audio.json'))
// The VAD owns a second, 16 kHz context. Use the main context only; otherwise
// recording the same microphone twice would double the input and add clock skew.
const mainRate = recording.marks[0]?.rate || 48000
const blocks = recording.blocks.filter(b => b.rate === mainRate && b.at > report.startedAt && b.at < report.finishedAt + 2000)
const start = Math.min(...blocks.map(b => b.at))
const end = Math.max(...blocks.map(b => b.at + b.pcm.length / b.rate * 1000))
const rate = 16000, samples = Math.ceil((end - start) * rate / 1000)
const channels = { input: new Float32Array(samples), output: new Float32Array(samples) }
for (const b of blocks) {
  const offset = Math.round((b.at - start) * rate / 1000)
  const n = Math.floor(b.pcm.length * rate / b.rate)
  for (let i = 0; i < n; i++) {
    if (offset + i >= samples) break
    channels[b.kind][offset + i] += b.pcm[Math.min(b.pcm.length - 1, Math.floor(i * b.rate / rate))] / (b.encoding === 's16' ? 32767 : 1)
  }
}
function spans(data) {
  const values = []
  for (let i = 0; i < data.length; i += 160) {
    let sum = 0
    for (let j = i; j < Math.min(data.length, i + 160); j++) sum += data[j] ** 2
    if (Math.sqrt(sum / 160) > 0.004) {
      const t = i / 16
      if (values.length && t - values.at(-1).end <= 120) values.at(-1).end = t + 10
      else values.push({ start: t, end: t + 10 })
    }
  }
  return values.filter(s => s.end - s.start >= 50)
}
const pcm = Buffer.alloc(samples * 4)
for (let i = 0; i < samples; i++) {
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels.input[i])) * 32767), i * 4)
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels.output[i])) * 32767), i * 4 + 2)
}
const header = Buffer.alloc(44)
header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22)
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32)
header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
writeFileSync(dir + label + '-stereo.wav', Buffer.concat([header, pcm]))
const summary = { label, start, measurement: 'Rendered WebAudio PCM, left=input right=cohost; timestamps reconstructed from AudioContext output clock. Not physical acoustic latency.',
  inputSpansMs: spans(channels.input), outputSpansMs: spans(channels.output),
  events: report.events.map(e => ({ ...e, ms: Math.round(e.at - start), at: undefined })),
  receipts: report.observations.filter(e => e.kind === 'browser-event').map(e => ({ ms: Math.round(e.at - start), ...e.body })),
  entries: report.final.room.entries.filter(e => ['host', 'assistant'].includes(e.role)),
  decisions: report.final.director.trace }
writeFileSync(dir + label + '-analysis.json', JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ label, inputSpans: summary.inputSpansMs.length, outputSpans: summary.outputSpansMs,
  speechEvents: summary.events.filter(e => e.type !== 'speech-progress'), receipts: summary.receipts.filter(e => !['speech-pause', 'speech-start', 'speech-end', 'transcript'].includes(e.type)),
  entries: summary.entries.map(({ role, text, status, interruptionReason }) => ({ role, text, status, interruptionReason })) }))
