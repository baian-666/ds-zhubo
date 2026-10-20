import { randomUUID } from 'node:crypto'
import { createContext } from '@moeru/eventa'
import { parse } from 'valibot'
import { statusEvent, statusSchema } from '../../packages/cohost-contracts/status.ts'

/** Read-only fanout. Slow consumers reconnect to a snapshot instead of buffering history. */
export class StatusStream {
  constructor(snapshot) {
    this.snapshot = snapshot
    this.context = createContext()
    this.epoch = randomUUID()
    this.revision = 0
    this.clients = new Set()
    this.context.on(statusEvent, event => {
      const line = JSON.stringify(event) + '\n'
      for (const response of this.clients) {
        if (!response.write(line)) response.destroy()
      }
    })
  }
  subscribe(response) {
    if (this.clients.size >= 8) return false
    this.publish()
    response.writeHead(200, {'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'})
    response.flushHeaders()
    this.clients.add(response)
    response.on('close', () => {
      this.clients.delete(response)
      if (!this.clients.size) { clearInterval(this.timer); this.timer = undefined }
    })
    const frame = {kind:'snapshot',epoch:this.epoch,revision:this.revision,status:this.current}
    response.write(JSON.stringify({...statusEvent,body:frame})+'\n')
    if (!this.timer) {
      this.pulseAt = Date.now()
      this.timer = setInterval(() => this.publish(), 200)
      this.timer.unref()
    }
    return true
  }
  publish() {
    const next = parse(statusSchema, this.snapshot())
    if (!this.current) { this.current = next; return }
    const previous = this.current
    const changes = {}
    for (const key of Object.keys(next)) {
      if (key !== 'room' && key !== 'performance' && JSON.stringify(next[key]) !== JSON.stringify(previous[key])) changes[key] = next[key]
    }
    let room
    if (previous.room.session === next.room.session && previous.room.version !== next.room.version) {
      const before = new Map(previous.room.entries.map(entry => [entry.id, entry]))
      const after = new Set(next.room.entries.map(entry => entry.id))
      room = {session:next.room.session,version:next.room.version,
        upsert:next.room.entries.filter(entry => !before.has(entry.id) || entry.revision === undefined || entry.revision !== before.get(entry.id).revision),
        removed:previous.room.entries.filter(entry => !after.has(entry.id)).map(entry => entry.id)}
    }
    const reset = previous.room.session !== next.room.session
    this.current = next
    if (reset || room || Object.keys(changes).length) {
      const base = this.revision++
      void this.context.emit(statusEvent, reset
        ? {kind:'snapshot',epoch:this.epoch,revision:this.revision,status:next}
        : {kind:'patch',epoch:this.epoch,revision:this.revision,base,changes,...(room ? {room} : {})})
    }
    // Web-stage performance control has a 1500 ms lease. Renew it independently
    // of chat changes, without retransmitting the conversation or advancing revision.
    const performanceChanged = JSON.stringify({...previous.performance,expiresAt:0}) !== JSON.stringify({...next.performance,expiresAt:0})
    if (performanceChanged || Date.now() - this.pulseAt >= 800) {
      this.pulseAt = Date.now()
      void this.context.emit(statusEvent,{kind:'pulse',epoch:this.epoch,revision:this.revision,performance:next.performance})
    }
  }
  close() {
    clearInterval(this.timer)
    for (const response of this.clients) response.destroy()
    this.clients.clear()
    this.context.abort()
  }
}
