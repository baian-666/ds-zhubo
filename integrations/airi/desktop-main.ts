import type { BrowserWindow as Window } from 'electron'

import { env } from 'node:process'

import { createContext } from '@moeru/eventa/adapters/electron/main'
import { BrowserWindow, ipcMain } from 'electron'

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
  const consoleWindow = new BrowserWindow({
    title: 'ds-zhubo',
    width: 1440,
    height: 960,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  consoleWindow.setMenuBarVisibility(false)
  consoleWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  consoleWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin)
      event.preventDefault()
  })
  void consoleWindow.loadURL(origin)
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
      const response = await fetch(`${origin}/api/status`, { headers, signal: request.signal })
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
    if (!consoleWindow.isDestroyed())
      consoleWindow.close()
  })
}
