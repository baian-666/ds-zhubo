/** Only implemented adapters are offered. Provider credentials stay on the local server. */
export const inferenceProviders = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-flash' }] as const
export const recognitionProviders = [
  { id: 'siliconflow', name: 'SiliconFlow', models: ['FunAudioLLM/SenseVoiceSmall'] },
  { id: 'dashscope', name: '阿里百炼', models: ['fun-asr-realtime'] },
  { id: 'local', name: '本地流式识别', models: ['sherpa-zipformer-zh'] },
] as const
