/** Capabilities describe the adapter in this application, not every feature of its model. */
export interface SpeechProvider {
  id: 'index' | 'aqua' | 'qwen' | 'siliconflow'
  model: string
  voices: readonly string[]
  capabilities: { transport: 'pcm-stream' | 'wav', reference: boolean, emotion: boolean }
}

/** The server publishes this only after validation and persistence succeed. */
export interface EffectiveSpeechConfig {
  schemaVersion: 1
  revision: string
  engine: SpeechProvider['id']
  model: string
  voice: string
  capabilities: SpeechProvider['capabilities']
}

export const speechProviders: readonly SpeechProvider[] = [
  { id: 'index', model: 'IndexTTS-2.5 / 本地分句', voices: ['local-reference'], capabilities: { transport: 'pcm-stream', reference: true, emotion: false } },
  { id: 'aqua', model: 'GPT-SoVITS V3 / Aqua 本地', voices: ['local-reference'], capabilities: { transport: 'pcm-stream', reference: true, emotion: false } },
  { id: 'qwen', model: 'Qwen 云端 / 预设与克隆', voices: ['Vivian', 'Cherry', 'Serena', 'Chelsie', 'Momo', '克隆音色'], capabilities: { transport: 'pcm-stream', reference: false, emotion: false } },
  { id: 'siliconflow', model: 'FunAudioLLM/CosyVoice2-0.5B', voices: ['claire', 'anna', 'bella', 'diana'], capabilities: { transport: 'wav', reference: false, emotion: false } },
]
