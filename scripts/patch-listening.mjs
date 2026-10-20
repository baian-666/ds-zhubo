import {readFileSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'

// Extend the pinned VAD event without replacing other local VAD changes.
const root=fileURLToPath(new URL('../vendor/airi/',import.meta.url))
function edit(path,replacements) {
  const target=join(root,path)
  let text=readFileSync(target,'utf8').replaceAll('\r\n','\n')
  for(const [before,after,previous] of replacements) {
    if(text.includes(after))continue
    const source=previous && text.includes(previous)?previous:before
    if(!text.includes(source))throw Error('Listening overlay anchor changed: '+path)
    text=text.replace(source,after)
  }
  writeFileSync(target,text)
}
edit('packages/stage-ui/src/libs/audio/vad.ts',[
  ['  newBufferSize: number', '  newBufferSize: number\n  /** Optional RMS floor for silence. Zero keeps model-only endpointing. */\n  silenceThreshold?: number'],
  ["'speech-audio': { buffer: Float32Array }","'speech-audio': { buffer: Float32Array, speech: boolean }"],
])
edit('packages/stage-ui/src/stores/ai/models/vad.ts',[
  ['interface UseVADOptions {', 'interface UseVADOptions {\n  silenceThreshold?: number'],
  ['        ...vadConfig,', '        ...vadConfig,\n        silenceThreshold: options?.silenceThreshold,', '        ...vadConfig,\n        silenceThreshold: options.silenceThreshold,'],
  ["import type { BaseVADConfig }", "import type { BaseVADConfig, VADEvents }"],
  ['onSpeechAudio?: (event: { buffer: Float32Array }) => void', "onSpeechAudio?: (event: VADEvents['speech-audio']) => void"],
])
edit('packages/stage-ui/src/workers/vad/vad.ts',[
  ['    const isSpeech = await this.detectSpeech(inputBuffer)', `    const detectedSpeech = await this.detectSpeech(inputBuffer)
    // Use the same waveform floor as the cohost pause clock. Keep the full silence duration.
    const silenceThreshold = this.config.silenceThreshold ?? 0
    const rms = Math.sqrt(inputBuffer.reduce((sum, value) => sum + value * value, 0) / inputBuffer.length)
    const isSpeech = detectedSpeech && (silenceThreshold <= 0 || rms >= silenceThreshold)`],
  ["      this.prevBuffers.push(inputBuffer.slice(0))\n\n      return", "      this.prevBuffers.push(inputBuffer.slice(0))\n      // Keep pause evidence alive after an ASR segment ends.\n      this.emit('speech-audio', { buffer: inputBuffer.slice(), speech: false })\n\n      return"],
  ["this.emit('speech-audio', { buffer: this.createLeadingSpeechAudio(inputBuffer) })", "this.emit('speech-audio', { buffer: this.createLeadingSpeechAudio(inputBuffer), speech: true })"],
  ["        this.emit('speech-audio', { buffer: inputBuffer.slice() })", "        this.emit('speech-audio', { buffer: inputBuffer.slice(), speech: true })"],
  ["    this.emit('speech-audio', { buffer: inputBuffer.slice() })", "    this.emit('speech-audio', { buffer: inputBuffer.slice(), speech: false })"],
])
const pauseTest=readFileSync(new URL('../integrations/airi/vad-pause.test.ts',import.meta.url))
writeFileSync(join(root,'packages/stage-ui/src/workers/vad/vad-pause.test.ts'),pauseTest)
