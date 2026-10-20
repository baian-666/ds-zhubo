import type { Status } from './cohost-status-contract'

import { onScopeDispose, shallowRef, watch } from 'vue'

import { cohostAccessToken, cohostNeedsToken } from '../../composables/cohost-media-state'
import { StatusConnection } from './cohost-status-connection'

const state = shallowRef<Status>()
const connected = shallowRef(false)
let users = 0
let stopTokenWatch: (() => void) | undefined
const connection = new StatusConnection(
  () => cohostAccessToken.value,
  (next) => {
    state.value = next
    cohostNeedsToken.value = false
  },
  (value) => { connected.value = value },
  () => { cohostNeedsToken.value = true },
)

/** One read-only subscription per renderer, shared by the panel and native settings. */
export function useCohostStatus() {
  if (users++ === 0) {
    stopTokenWatch = watch(cohostAccessToken, () => connection.start())
    connection.start()
  }
  onScopeDispose(() => {
    if (--users === 0) {
      stopTokenWatch?.()
      connection.stop()
    }
  })
  return { state, connected }
}
