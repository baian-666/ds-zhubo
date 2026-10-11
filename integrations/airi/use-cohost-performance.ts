import type { Command, Receipt } from './cohost-contract'

import { createContext } from '@moeru/eventa/adapters/window-message'
import { neutralLive2DMotionControlPose, useLive2DMotionControl } from '@proj-airi/stage-ui-live2d/stores'
import { useSettingsStageModel } from '@proj-airi/stage-ui/stores/settings/stage-model'
import { useStartupResourcesStore } from '@proj-airi/stage-ui/stores/startup-resources'
import { onMounted, onUnmounted } from 'vue'

import * as v from 'valibot'

import { channel, commandEvent, commandSchema, receiptEvent } from './cohost-contract'

/**
 * Runs transient poses for the local rehearsal iframe. No model credentials cross this boundary.
 * Commands use a session and sequence. A 1500 ms lease releases control after the parent disconnects.
 * Unmount releases ownership before it disposes the transport. Saved model settings stay unchanged.
 */
export function useCohostPerformance(connect?: (receive: (body: unknown) => void) => { emit: (receipt: Receipt) => void, dispose: () => void }, modelReady?: () => boolean) {
  const motion = useLive2DMotionControl()
  const settings = useSettingsStageModel()
  const startup = useStartupResourcesStore()
  const owner = 'ds-zhubo:performance'
  let runtime: ReturnType<typeof createContext> | undefined
  let external: { emit: (receipt: Receipt) => void, dispose: () => void } | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let command: Command | undefined
  let receivedAt = 0
  let owned = false

  function release() {
    if (!owned)
      return
    motion.release(owner)
    motion.releaseExclusiveControl(owner)
    owned = false
  }

  function tick() {
    const now = Date.now()
    if (!command || now - receivedAt > 1500) {
      release()
      return
    }
    const ready = settings.stageModelRenderer === 'live2d'
      && (modelReady ? modelReady() : startup.resources.some(resource => resource.id === 'model' && resource.status === 'ready'))
    const name = command.expiresAt > now ? command.name : 'idle'
    if (!ready || name === 'idle') {
      release()
    }
    else {
      if (!owned) {
        motion.claimExclusiveControl(owner)
        owned = true
      }
      const pose = { ...neutralLive2DMotionControlPose }
      const wave = Math.sin(now / 230)
      if (name === 'listen') {
        pose.headZ = 0.09
        pose.eyeX = -0.1
      }
      if (name === 'think') {
        pose.headZ = -0.22
        pose.eyeY = 0.35
        pose.eyeX = 0.25
      }
      if (name === 'nod') {
        pose.headY = wave * 0.25
        pose.eyeSquint = 0.12
      }
      if (name === 'smile') {
        pose.eyeSquint = 0.55
        pose.mouthForm = 0.8
        pose.headZ = 0.15
      }
      if (name === 'surprise') {
        pose.headY = 0.25
        pose.headZ = -0.15
        pose.bodyY = -0.15
      }
      if (name === 'pout') {
        pose.mouthForm = -0.7
        pose.headX = -0.3
        pose.eyeX = 0.25
        pose.headZ = -0.2
      }
      motion.setPose(owner, pose, { follow: 0.85, inertia: 0.25 })
    }
    const receipt = { ready, name, session: command.session, id: command.id }
    void runtime?.context.emit(receiptEvent, receipt)
    external?.emit(receipt)
  }

  function receive(body: unknown) {
    const parsed = v.safeParse(commandSchema, body)
    if (!parsed.success)
      return
    const incoming = parsed.output
    if (incoming.session === command?.session && incoming.id < command.id)
      return
    if (incoming.expiresAt > Date.now() + 5000)
      return
    command = incoming
    receivedAt = Date.now()
    tick()
  }

  onMounted(() => {
    if (connect) {
      external = connect(receive)
      timer = setInterval(tick, 100)
      return
    }
    const parentOrigin = new URLSearchParams(location.search).get('cohostOrigin')
    if (window.parent === window || !parentOrigin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(parentOrigin))
      return
    runtime = createContext({ channel, currentWindow: window, targetWindow: () => window.parent, expectedSource: () => window.parent, expectedOrigin: parentOrigin, targetOrigin: parentOrigin })
    runtime.context.on(commandEvent, ({ body }) => receive(body))
    timer = setInterval(tick, 100)
  })
  onUnmounted(() => {
    clearInterval(timer)
    release()
    runtime?.dispose()
    external?.dispose()
  })
}
