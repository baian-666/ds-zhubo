import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import { PausableAudio } from './pausable-audio'

it('pauses the source while the microphone context runs and resumes without replaying its prefix', async () => {
  const context = new AudioContext()
  const unlock = document.createElement('button')
  unlock.textContent = 'Enable test audio'
  unlock.onclick = () => {
    void context.resume()
  }
  document.body.append(unlock)
  await page.getByRole('button', { name: 'Enable test audio' }).click()
  await vi.waitFor(() => expect(context.state).toBe('running'))
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate)
  const output = context.createGain()
  output.gain.value = 0
  output.connect(context.destination)
  const controller = new AbortController()
  const audio = new PausableAudio(context, buffer, output, controller.signal)
  try {
    audio.setPaused(false)
    await vi.waitFor(() => expect(audio.elapsedMs).toBeGreaterThan(80))
    audio.setPaused(true)
    const pausedAt = audio.elapsedMs
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(context.state).toBe('running')
    expect(audio.elapsedMs).toBe(pausedAt)
    audio.setPaused(false)
    await vi.waitFor(() => expect(audio.elapsedMs).toBeGreaterThan(pausedAt + 40))
    controller.abort()
    await audio.done
    const cancelledAt = audio.elapsedMs
    audio.setPaused(false)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(audio.elapsedMs).toBe(cancelledAt)
  }
  finally {
    controller.abort()
    output.disconnect()
    unlock.remove()
    await context.close()
  }
})
