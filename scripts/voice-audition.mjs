import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Fixed fictional lines only: no microphone, room history or user recording is uploaded.
const model = 'FunAudioLLM/CosyVoice2-0.5B'
const input = '晚上好呀，我是小鲸鱼。别看我个头小，接梗可是很认真的。你负责讲故事，我负责让直播间热闹起来。'
const voices = ['claire', 'diana', 'bella']
const key = process.env.SILICONFLOW_API_KEY
if (!key) {
  console.error('请先完成本机语音账号配置。')
  process.exit(1)
}
const folder = new URL('../data/voice-audition/', import.meta.url)
mkdirSync(folder, { recursive: true })
const results = await Promise.all(voices.map(async voice => {
  const started = performance.now()
  try {
    const response = await fetch('https://api.siliconflow.cn/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice: model + ':' + voice, input, speed: 1, gain: 0,
        response_format: 'wav', sample_rate: 24000, stream: false }),
      signal: AbortSignal.timeout(45000), redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { voice, ok: false, status: response.status }
    }
    const audio = Buffer.from(await response.arrayBuffer())
    if (audio.length < 44 || audio.length > 8_000_000 || audio.toString('ascii', 0, 4) !== 'RIFF' ||
        audio.toString('ascii', 8, 12) !== 'WAVE') return { voice, ok: false, error: 'invalid-audio' }
    const file = new URL(voice + '.wav', folder)
    writeFileSync(file, audio)
    return { voice, ok: true, path: fileURLToPath(file), bytes: audio.length,
      elapsedMs: Math.round(performance.now() - started) }
  } catch {
    return { voice, ok: false, error: 'network-or-timeout' }
  }
}))
const report = { kind: 'real cloud TTS with fixed fictional text, no live configuration changes',
  model, input, speed: 1, gain: 0, calls: voices.length, results }
writeFileSync(new URL('result.json', folder), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
if (results.some(result => !result.ok)) process.exitCode = 1
