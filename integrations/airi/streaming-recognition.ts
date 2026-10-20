import { toPCM16FromFloat32 } from '@proj-airi/audio/encoding'

import * as v from 'valibot'

const frameSchema = v.variant('type', [
  v.object({ type: v.literal('ready') }),
  v.object({ type: v.literal('partial'), text: v.pipe(v.string(), v.maxLength(2000)) }),
  v.object({ type: v.literal('final'), text: v.pipe(v.string(), v.maxLength(2000)), asrMs: v.number() }),
  v.object({ type: v.literal('error'), message: v.string() }),
])

/**
 * Owns one VAD segment. Audio uploads during speech, while only task completion delivers a final transcript.
 * The local capture lease authenticates requests. Provider credentials remain on the backend.
 * Cancellation, queue overflow, or transport failure discard the whole segment.
 */
export class StreamingRecognition {
  private readonly controller = new AbortController()
  private readonly chunks: Uint8Array[] = []
  private bytes = 0
  private total = 0
  private sequence = 0
  private ready = false
  private ended = false
  private sending = false
  private complete = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly origin: string,
    private readonly headers: Record<string, string>,
    private readonly utterance: number,
    private readonly onPartial: (text: string) => void,
    private readonly onFinal: (text: string) => void,
    private readonly onError: () => void,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.timer = setTimeout(() => this.fail(), 70000)
    void this.read().catch(() => this.fail())
  }

  push(buffer: Float32Array) {
    if (this.controller.signal.aborted || this.ended)
      return
    const pcm = new Uint8Array(toPCM16FromFloat32(buffer).buffer)
    this.total += pcm.length
    this.bytes += pcm.length
    // Keep at most eight seconds while the cloud task opens or the local relay stalls.
    if (this.bytes > 256000 || this.total > 1760000) {
      this.fail()
      return
    }
    for (let offset = 0; offset < pcm.length; offset += 8192)
      this.chunks.push(pcm.slice(offset, offset + 8192))
    void this.flush().catch(() => this.fail())
  }

  end() {
    this.ended = true
    void this.flush().catch(() => this.fail())
  }

  cancel() {
    clearTimeout(this.timer)
    this.controller.abort()
    this.chunks.length = 0
    this.bytes = 0
  }

  private fail() {
    if (this.controller.signal.aborted || this.complete)
      return
    this.cancel()
    this.onError()
  }

  private async request(path: string, body: Record<string, unknown>) {
    const response = await this.fetchImpl(`${this.origin}/api/airi/stage/recognition/${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ utterance: this.utterance, ...body }),
      signal: path === 'open' ? this.controller.signal : AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]),
    })
    if (!response.ok)
      throw new Error('Recognition transport failed')
    return response
  }

  private async flush() {
    if (this.sending || !this.ready || this.controller.signal.aborted)
      return
    this.sending = true
    try {
      // Send each 32 ms VAD frame as it arrives. The local relay keeps upload order.
      while (!this.controller.signal.aborted && this.chunks.length && (this.ended || this.bytes >= 1024)) {
        const chunks: Uint8Array[] = []
        let length = 0
        while (this.chunks.length && length + this.chunks[0].length <= 16384) {
          const chunk = this.chunks.shift()!
          chunks.push(chunk)
          length += chunk.length
        }
        const pcm = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          pcm.set(chunk, offset)
          offset += chunk.length
        }
        const response = await this.request('chunk', { sequence: this.sequence++, pcm: btoa(String.fromCharCode(...pcm)) })
        await response.json()
        this.bytes -= length
      }
      if (this.ended && !this.chunks.length && !this.controller.signal.aborted) {
        this.ready = false
        const response = await this.request('finish', { sequence: this.sequence })
        await response.json()
      }
    }
    finally { this.sending = false }
  }

  private async read() {
    const response = await this.request('open', {})
    if (!response.body)
      throw new Error('Missing recognition stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    try {
      while (!this.controller.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done)
          break
        pending += decoder.decode(chunk.value, { stream: true })
        if (pending.length > 32000)
          throw new Error('Recognition frame too large')
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          const frame = v.parse(frameSchema, JSON.parse(pending.slice(0, end)))
          pending = pending.slice(end + 1)
          if (this.controller.signal.aborted)
            return
          if (frame.type === 'error')
            throw new Error('Recognition failed')
          if (frame.type === 'ready') {
            this.ready = true
            void this.flush().catch(() => this.fail())
          }
          else if (frame.type === 'partial') {
            this.onPartial(frame.text)
          }
          else if (frame.type === 'final') {
            if (!this.ended || this.complete)
              throw new Error('Unexpected recognition completion')
            this.complete = true
            this.onFinal(frame.text)
            this.cancel()
            return
          }
        }
      }
      if (!this.complete && !this.controller.signal.aborted)
        throw new Error('Recognition stream ended before completion')
    }
    finally { await reader.cancel().catch(() => {}) }
  }
}
