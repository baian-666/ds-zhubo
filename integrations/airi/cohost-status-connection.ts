import type { Status } from './cohost-status-contract'

import { createContext } from '@moeru/eventa'

import * as v from 'valibot'

import { statusEvent, statusMessageSchema, StatusReplica } from './cohost-status-contract'

/** Authenticated read-only connection; reconnects always start from a fresh snapshot. */
export class StatusConnection {
  private controller: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private generation = 0
  private failures = 0
  private readonly token: () => string
  private readonly receive: (state: Status) => void
  private readonly connected: (value: boolean) => void
  private readonly unauthorized: () => void

  constructor(token: () => string, receive: (state: Status) => void, connected: (value: boolean) => void, unauthorized: () => void) {
    this.token = token
    this.receive = receive
    this.connected = connected
    this.unauthorized = unauthorized
  }

  start() {
    this.stop()
    this.stopped = false
    void this.connect(this.generation)
  }

  private async connect(generation: number) {
    if (this.stopped || generation !== this.generation)
      return
    const controller = new AbortController()
    this.controller = controller
    const replica = new StatusReplica()
    const context = createContext()
    context.on(statusEvent, ({ body }) => {
      if (!body || this.stopped || generation !== this.generation)
        return
      this.receive(replica.accept(body))
      this.connected(true)
      this.failures = 0
    })
    let watchdog = setTimeout(() => controller.abort(), 5000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let authenticationFailed = false
    try {
      const response = await fetch('http://127.0.0.1:8787/api/status/events', {
        headers: this.token() ? { Authorization: `Bearer ${this.token()}` } : {},
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      if (response.status === 401) {
        authenticationFailed = true
        this.unauthorized()
      }
      if (!response.ok || !response.body)
        throw new Error('Status connection unavailable')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read()
        if (done)
          break
        pending += decoder.decode(value, { stream: true })
        if (pending.length > 4_000_000)
          throw new Error('Status frame too large')
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          const message = v.parse(statusMessageSchema, JSON.parse(line))
          await context.emit(statusEvent, message.body)
          clearTimeout(watchdog)
          watchdog = setTimeout(() => controller.abort(), 5000)
        }
      }
    }
    catch {
      // Transport or revision failure is recovered only by reconnecting to a snapshot.
    }
    finally {
      clearTimeout(watchdog)
      controller.abort()
      await reader?.cancel().catch(() => {})
      context.abort()
      if (!this.stopped && generation === this.generation) {
        this.connected(false)
        if (!authenticationFailed) {
          const delay = Math.min(5000, 500 * 2 ** Math.min(this.failures++, 4))
          this.timer = setTimeout(() => void this.connect(generation), delay)
        }
      }
    }
  }

  stop() {
    this.stopped = true
    this.generation++
    clearTimeout(this.timer)
    this.controller?.abort()
    this.connected(false)
  }
}
