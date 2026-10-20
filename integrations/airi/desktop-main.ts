import type { BrowserWindow as Window } from 'electron'

import { env } from 'node:process'

import { createContext } from '@moeru/eventa/adapters/electron/main'
import { ipcMain, screen } from 'electron'

import * as v from 'valibot'

import { commandEvent, commandSchema } from './cohost-contract'

/**
 * Connects one desktop stage to the local cohost. The renderer receives no credentials.
 * Polls stop with the stage window. Its pose lease expires when the local server disconnects.
 */
export function connectCohostDesktop(stage: Window) {
  if (env.DS_ZHUBO_DESKTOP !== '1')
    return
  const origin = 'http://127.0.0.1:8787'
  const runtime = createContext(ipcMain, stage)
  let busy = false
  let closed = false
  let request: AbortController | undefined
  // The stage and live room now share one window. Keep enough space for both.
  const { workArea } = screen.getDisplayMatching(stage.getBounds())
  stage.setMinimumSize(Math.min(960, workArea.width), Math.min(700, workArea.height))
  const [width, height] = stage.getSize()
  stage.setSize(Math.min(Math.max(width, 1180), workArea.width), Math.min(Math.max(height, 820), workArea.height))
  const bounds = stage.getBounds()
  stage.setPosition(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)), Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height)))
  async function poll() {
    if (busy || closed || stage.isDestroyed())
      return
    busy = true
    request = new AbortController()
    const timeout = setTimeout(() => request?.abort(), 1200)
    try {
      const headers: Record<string, string> = {}
      if (env.COHOST_ACCESS_TOKEN)
        headers.Authorization = `Bearer ${env.COHOST_ACCESS_TOKEN}`
      const response = await fetch(`${origin}/api/stage-performance`, { headers, signal: request.signal })
      if (!response.ok)
        return
      const data: unknown = await response.json()
      const parsed = v.safeParse(v.object({ performance: commandSchema }), data)
      if (parsed.success && !closed)
        void runtime.context.emit(commandEvent, parsed.output.performance)
    }
    catch {
      // The renderer releases control when no command renews its lease.
    }
    finally {
      clearTimeout(timeout)
      busy = false
    }
  }
  const timer = setInterval(() => {
    void poll()
  }, 400)
  stage.on('closed', () => {
    closed = true
    clearInterval(timer)
    request?.abort()
    runtime.dispose()
  })
}
