import type { PlaybackItem } from '@proj-airi/pipelines-audio'

import { createPlaybackManager, createSpeechPipeline, createTtsSegmentStream } from '@proj-airi/pipelines-audio'
import { onUnmounted } from 'vue'

import { useAudioContext } from '../stores/audio'
import { cohostAudioBus, cohostCaption, cohostControlId, cohostPlaying, observePerformance } from './cohost-media-state'
import { PausableAudio } from './pausable-audio'
import { useCohostCharacter } from './use-cohost-character'
import { useCohostVoice } from './use-cohost-voice'

/**
 * The application owns playback and capture until its window closes.
 * Routes only attach animation analysers to the bus. Navigation cannot cancel speech.
 */
export function useCohostMediaHost(stage: 'web' | 'desktop') {
  useCohostCharacter(stage)
  const { audioContext } = useAudioContext()
  const bus = audioContext.createGain()
  bus.connect(audioContext.destination)
  cohostAudioBus.value = bus
  const voice = useCohostVoice(audioContext, () => true, stage, cohostControlId)

  async function play(item: PlaybackItem<AudioBuffer>, signal: AbortSignal) {
    await audioContext.resume()
    if (!await voice.beforePlay(item.turnId, signal) || signal.aborted)
      throw new Error('Cohost playback cancelled')
    const audio = new PausableAudio(audioContext, item.audio, bus, signal)
    const untrack = voice.trackListeningAudio(item.turnId, item.audio.duration * 1000, () => audio.elapsedMs)
    let beat = 0
    const unwatch = voice.watchFloor((paused) => {
      audio.setPaused(paused)
      cohostPlaying.value = !paused && !signal.aborted
      voice.playingSegment(item.turnId, item.text, audio.elapsedMs)
    })
    observePerformance((clock) => {
      const key = voice.playbackKey(item.turnId)
      if (!key)
        return
      const samples = item.audio.getChannelData(0)
      beat = clock.start(key, item.audio.duration * 1000, () => audio.elapsedMs, (offset) => {
        if (audio.isPaused || audioContext.state !== 'running')
          return 0
        const start = Math.floor(offset * item.audio.sampleRate / 1000)
        const end = Math.min(samples.length, start + Math.ceil(item.audio.sampleRate * 0.02))
        let sum = 0
        for (let index = start; index < end; index++)
          sum += samples[index] ** 2
        return Math.sqrt(sum / Math.max(1, end - start))
      })
    })
    cohostCaption.value = item.text
    voice.scheduled(item.turnId)
    try {
      await audio.done
    }
    finally {
      untrack()
      unwatch()
      observePerformance(clock => clock.finish(beat))
      cohostPlaying.value = false
    }
  }

  const playback = createPlaybackManager<AudioBuffer>({ play, maxVoices: 1, maxVoicesPerOwner: 1, overflowPolicy: 'queue', ownerOverflowPolicy: 'steal-oldest' })
  const pipeline = createSpeechPipeline<AudioBuffer>({
    playback,
    // The director sends complete sentences. A comma split adds another cloud startup inside the sentence.
    segmenter: (tokens, meta) => createTtsSegmentStream(tokens, meta, { preserveSourceText: true, boost: 0, maximumWords: 24 }),
    tts: () => Promise.resolve(null),
    ttsStream: (request, signal) => voice.synthesizeStream(request, signal),
  })
  voice.bind(pipeline)
  const unlock = () => {
    void audioContext.resume().catch(() => {})
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
  onUnmounted(() => {
    pipeline.stopAll('application closed')
    bus.disconnect()
    cohostAudioBus.value = undefined
    cohostPlaying.value = false
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  })
}
