import { readFileSync } from 'node:fs'
import { CLONE_MODELS, validQwenVoice } from '../../scripts/qwen-realtime-client.mjs'
import { validAudioClone } from '../../scripts/qwen-audio-client.mjs'

/** Local enrollment metadata only: never credentials or reference audio. */
export function loadQwenClone(path = new URL('../../data/qwen/voice.json', import.meta.url)) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw Object.assign(new Error('请先配置本机 Qwen 克隆音色（data/qwen/voice.json），原声音配置已保留。'), { status: 503 }) }
  return validateQwenClone(value)
}

export function validateQwenClone(value) {
  if (!value || !(validAudioClone(value.model, value.voice) || (CLONE_MODELS.includes(value.model) && validQwenVoice(value.model, value.voice))))
    throw Object.assign(new Error('Qwen 克隆音色编号或对应模型无效，原声音配置已保留。'), { status: 400 })
  return { model: value.model, voice: value.voice }
}
