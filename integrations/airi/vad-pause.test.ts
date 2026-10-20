import type { PreTrainedModel } from '@huggingface/transformers'

import { AutoModel } from '@huggingface/transformers'
import { expect, it, vi } from 'vitest'

import { VAD } from './vad'

vi.mock('@huggingface/transformers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@huggingface/transformers')>()
  return { ...actual, AutoModel: { from_pretrained: vi.fn() } }
})

it('keeps sending real quiet frames after a speech segment has ended', async () => {
  const probabilities = [...Array.from<number>({ length: 30 }).fill(0.9), ...Array.from<number>({ length: 200 }).fill(0)]
  const model = vi.fn(async (input: { state: unknown }) => ({ stateN: input.state, output: { data: new Float32Array([probabilities.shift() ?? 0]) } }))
  vi.mocked(AutoModel.from_pretrained).mockResolvedValue(model as unknown as PreTrainedModel)
  const vad = new VAD({ sampleRate: 16000, newBufferSize: 160, minSilenceDurationMs: 650, minSpeechDurationMs: 300 })
  const ready = vi.fn()
  const audio = vi.fn()
  vad.on('speech-ready', ready)
  vad.on('speech-audio', audio)
  await vad.initialize()
  for (let index = 0; index < 230; index++)
    await vad.processAudio(new Float32Array(160))
  expect(ready).toHaveBeenCalledOnce()
  expect(audio).toHaveBeenCalledTimes(230)
  expect(audio.mock.lastCall?.[0].speech).toBe(false)
})

it.each([320, 650])('ends at %i ms of waveform silence without dropping resumed speech', async (silenceMs) => {
  const model = vi.fn(async (input: { state: unknown }) => ({ stateN: input.state, output: { data: new Float32Array([0.9]) } }))
  vi.mocked(AutoModel.from_pretrained).mockResolvedValue(model as unknown as PreTrainedModel)
  const vad = new VAD({ sampleRate: 16000, minSilenceDurationMs: silenceMs, silenceThreshold: 0.003 })
  const quietFrames = Math.ceil(silenceMs / 32)
  const shortPauseFrames = quietFrames - 2
  const ready = vi.fn()
  const audio = vi.fn()
  vad.on('speech-ready', ready)
  vad.on('speech-audio', audio)
  await vad.initialize()
  for (let index = 0; index < 20; index++)
    await vad.processAudio(new Float32Array(512).fill(0.1))
  for (let index = 0; index < shortPauseFrames; index++)
    await vad.processAudio(new Float32Array(512))
  expect(ready).not.toHaveBeenCalled()
  await vad.processAudio(new Float32Array(512).fill(0.1))
  for (let index = 0; index < quietFrames - 1; index++)
    await vad.processAudio(new Float32Array(512))
  expect(ready).not.toHaveBeenCalled()
  await vad.processAudio(new Float32Array(512))
  expect(ready).toHaveBeenCalledOnce()
  expect(audio).toHaveBeenCalledTimes(20 + shortPauseFrames + 1 + quietFrames)
  expect(ready.mock.lastCall?.[0].buffer.some((value: number) => value > 0)).toBe(true)
})

it('keeps an acknowledgment segment open when playback requests the longer window', async () => {
  const model = vi.fn(async (input: { state: unknown }) => ({ stateN: input.state, output: { data: new Float32Array([0.9]) } }))
  vi.mocked(AutoModel.from_pretrained).mockResolvedValue(model as unknown as PreTrainedModel)
  const vad = new VAD({ sampleRate: 16000, minSilenceDurationMs: 320, silenceThreshold: 0.003 })
  const ready = vi.fn()
  vad.on('speech-ready', ready)
  await vad.initialize()
  for (let index = 0; index < 20; index++)
    await vad.processAudio(new Float32Array(512).fill(0.1))
  for (let index = 0; index < 8; index++)
    await vad.processAudio(new Float32Array(512))
  vad.updateConfig({ minSilenceDurationMs: 650 })
  for (let index = 0; index < 12; index++)
    await vad.processAudio(new Float32Array(512))
  expect(ready).not.toHaveBeenCalled()
  await vad.processAudio(new Float32Array(512))
  expect(ready).toHaveBeenCalledOnce()
  vad.updateConfig({ minSilenceDurationMs: 320 })
  for (let index = 0; index < 20; index++)
    await vad.processAudio(new Float32Array(512).fill(0.1))
  for (let index = 0; index < 10; index++)
    await vad.processAudio(new Float32Array(512))
  expect(ready).toHaveBeenCalledTimes(2)
})
