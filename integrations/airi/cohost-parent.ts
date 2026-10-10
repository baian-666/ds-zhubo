import type { Command, Receipt } from './cohost-contract'

import { createContext } from '@moeru/eventa/adapters/window-message'

import { channel, commandEvent, receiptEvent } from './cohost-contract'

/** Owns one iframe connection. Each update renews a short renderer lease. */
export function connectStage(frame: HTMLIFrameElement, onReceipt: (receipt: Receipt) => void) {
  const origin = 'http://127.0.0.1:5173'
  const runtime = createContext({ channel, currentWindow: window, targetWindow: () => frame.contentWindow, expectedSource: () => frame.contentWindow, expectedOrigin: origin, targetOrigin: origin })
  let current: Command | undefined
  let receivedSequence = -1
  runtime.context.on(receiptEvent, ({ body }) => {
    if (!body || body.session !== current?.session || body.id !== current.id)
      return
    onReceipt(body)
  })
  window.addEventListener('pagehide', () => runtime.dispose(), { once: true })
  return {
    update(command: Command, sequence: number) {
      if (sequence < receivedSequence)
        return
      receivedSequence = sequence
      current = command
      void runtime.context.emit(commandEvent, command)
    },
  }
}
