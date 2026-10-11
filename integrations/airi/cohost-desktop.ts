import type { Receipt } from './cohost-contract'

import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import { commandEvent, receiptEvent } from './cohost-contract'
import { useCohostPerformance } from './use-cohost-performance'

/** Shares the pose driver with the web stage. The main stage owns this subscription. */
export function useCohostDesktopPerformance(modelReady: () => boolean) {
  useCohostPerformance((receive) => {
    const context = getElectronEventaContext()
    const dispose = context.on(commandEvent, ({ body }) => receive(body))
    return {
      emit: (receipt: Receipt) => { void context.emit(receiptEvent, receipt) },
      dispose,
    }
  }, modelReady)
}
