import type { Command, Receipt } from './cohost-contract'
import type { poseParameters } from './pose-control.ts'

import { createContext } from '@moeru/eventa/adapters/window-message'
import { useSettingsLive2d } from '@proj-airi/stage-ui-live2d/composables/live2d'
import { neutralLive2DMotionControlPose, useExpressionStore, useL2dViewControl, useLive2DMotionControl } from '@proj-airi/stage-ui-live2d/stores'
import { cohostPerformanceClock, cohostPerformanceRhythm } from '@proj-airi/stage-ui/composables/cohost-media-state'
import { DisplayModelFormat, useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useSettingsStageModel } from '@proj-airi/stage-ui/stores/settings/stage-model'
import { useStartupResourcesStore } from '@proj-airi/stage-ui/stores/startup-resources'
import { until } from '@vueuse/core'
import { computed, onMounted, onUnmounted } from 'vue'

import * as v from 'valibot'

import { channel, commandEvent, commandSchema, receiptEvent } from './cohost-contract'
import { evaluatePerformance, performanceTarget } from '../../packages/cohost-contracts/performance.ts'
import { parseMotionSequence, sampleMotionSequence, sequenceDuration } from './motion-sequence'
import { sampleNod } from './pose-control'
import { RigController } from './rig-controller'
import { whaleCapabilities } from './whale-capabilities'

/**
 * Runs transient poses for the local rehearsal iframe. No model credentials cross this boundary.
 * Commands use a session and sequence. A 1500 ms lease releases control after the parent disconnects.
 * Unmount releases ownership before it disposes the transport. Transient expressions do not change saved defaults.
 */
export function useCohostPerformance(connect?: (receive: (body: unknown) => void) => { emit: (receipt: Receipt) => void, dispose: () => void }, modelReady?: () => boolean) {
  const motion = useLive2DMotionControl()
  const expressions = useExpressionStore()
  const settings = useSettingsStageModel()
  const models = useDisplayModelsStore()
  const live2d = useSettingsLive2d()
  const view = useL2dViewControl()
  const modelImport = new AbortController()
  const startup = useStartupResourcesStore()
  const owner = 'ds-zhubo:performance'
  let runtime: ReturnType<typeof createContext> | undefined
  let external: { emit: (receipt: Receipt) => void, dispose: () => void } | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let command: Command | undefined
  let receivedAt = 0
  let owned = false
  let modelImporting = false
  let poseTakenOver = false

  const capabilities = computed(() => whaleCapabilities(expressions, live2d.live2dExpressionEnabled, settings.stageModelRenderer))
  const rig = new RigController(expressions)
  let nativeExpression = ''
  let policySignature = ''
  let blockedCommand: { session: string, id: number } | undefined

  function release() {
    try {
      rig.restore()
    }
    finally {
      nativeExpression = ''
      if (owned) {
        motion.release(owner)
        motion.releaseExclusiveControl(owner)
        owned = false
      }
    }
  }

  function emit(receipt: Receipt) {
    void runtime?.context.emit(receiptEvent, receipt)
    external?.emit(receipt)
  }

  function tick() {
    try {
      tickPerformance()
    }
    catch {
      // Animation errors cannot escape into the media controller or the text stream.
      if (command) {
        blockedCommand = { session: command.session, id: command.id }
        emit({ ready: false, name: 'idle', session: command.session, id: command.id, outcome: 'failed', issues: ['adapter-failed'] })
      }
      command = undefined
      try {
        release()
      }
      catch {
        // The model can disappear during teardown.
      }
    }
  }

  function tickPerformance() {
    const now = Date.now()
    const policy = performanceTarget(capabilities.value).revision
    if (policySignature && policySignature !== policy) {
      if (command) {
        blockedCommand = { session: command.session, id: command.id }
        emit({ ready: false, name: 'idle', session: command.session, id: command.id, outcome: 'stale', issues: ['stale-capabilities'] })
      }
      command = undefined
      release()
    }
    policySignature = policy
    if (!command || now - receivedAt > 1500) {
      release()
      return
    }
    const ready = !modelImporting && settings.stageModelRenderer === 'live2d'
      && (modelReady ? modelReady() : startup.resources.some(resource => resource.id === 'model' && resource.status === 'ready'))
    const decision = evaluatePerformance(command, capabilities.value, now)
    let name = decision.performance as Command['name']
    const plan = decision.motion && parseMotionSequence(decision.motion)
    if (decision.motion && !plan)
      name = 'idle'
    const beat = cohostPerformanceRhythm.sample(command, cohostPerformanceClock.sample(), now)
    const elapsed = beat.speech && plan ? Math.min(beat.elapsedMs, sequenceDuration(plan) - 1) : beat.elapsedMs
    const sample = name === 'sequence' && plan && !beat.waiting
      ? sampleMotionSequence(plan, elapsed)
      : undefined
    const waiting = decision.outcome === 'waiting' || beat.waiting
    if (!ready || name === 'idle' || waiting || sample?.finished || beat.finished) {
      release()
    }
    else {
      const basicExpression = ['smile', 'think', 'surprise', 'pout'].includes(name) ? { name: name as 'smile' | 'think' | 'surprise' | 'pout', strength: 1 } : undefined
      nativeExpression = rig.apply(sample ? sample.expressions : basicExpression, sample ? sample.components : {}, beat.weight)
      const pose: Partial<typeof neutralLive2DMotionControlPose> = {}
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
        pose.headY = sampleNod(beat.elapsedMs)
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
      if (sample)
        Object.assign(pose, sample.pose)
      if (motion.exclusiveOwnerId && motion.exclusiveOwnerId !== owner)
        poseTakenOver = true
      const axes = (Object.keys(pose) as (keyof typeof poseParameters)[]).filter(axis => rig.permitsPose(axis))
      if (poseTakenOver || axes.length === 0) {
        motion.release(owner)
        motion.releaseExclusiveControl(owner)
        owned = false
      }
      else {
        if (!owned) {
          motion.claimExclusiveControl(owner)
          owned = true
        }
        const target = { ...neutralLive2DMotionControlPose }
        for (const axis of axes)
          target[axis] = (pose[axis] ?? 0) * beat.poseWeight
        motion.setPose(owner, target, { follow: 0.85, inertia: 0.25 }, axes)
      }
    }
    const manual = poseTakenOver || rig.manuallyControlled
    const outcome = !ready ? 'unavailable' : decision.motion && !plan ? 'unsupported' : sample?.finished || beat.finished ? 'idle' : waiting ? 'waiting' : manual && name !== 'idle' ? 'partial' : decision.outcome
    const issues = [...decision.issues]
    if (decision.motion && !plan)
      issues.push('adapter-unsupported')
    if (manual)
      issues.push('manual-control')
    emit({ ready, name, expression: nativeExpression, session: command.session, id: command.id, label: command.motion?.label, step: sample?.step, waiting, outcome, issues: issues.slice(0, 32) })
  }

  function receive(body: unknown) {
    const parsed = v.safeParse(commandSchema, body)
    if (!parsed.success)
      return
    const incoming = parsed.output
    if (blockedCommand?.session === incoming.session && incoming.id <= blockedCommand.id)
      return
    if (incoming.session === command?.session && incoming.id < command.id)
      return
    if (incoming.expiresAt > Date.now() + 5000 || (incoming.startedAt !== undefined && incoming.startedAt !== null && incoming.startedAt > Date.now() + 500))
      return
    if (incoming.session !== command?.session || incoming.id !== command.id) {
      release()
      poseTakenOver = false
    }
    command = incoming
    receivedAt = Date.now()
    tick()
  }

  async function loadLocalModel() {
    // The local web stage adopts the prepared model once per profile.
    if (!settings.stageModelSelected.startsWith('preset-') || localStorage.getItem('cohost/whale-installed-v2'))
      return
    modelImporting = true
    try {
      // Card startup can restore its own model selection. Import after it settles.
      await until(() => startup.resources.find(resource => resource.id === 'modelSelection')?.status === 'ready')
        .toBe(true, { timeout: 30000, throwOnTimeout: true })
      if (modelImport.signal.aborted || !settings.stageModelSelected.startsWith('preset-'))
        return
      const response = await fetch('/cohost-whale.zip', { signal: modelImport.signal })
      if (!response.ok || !response.headers.get('content-type')?.includes('zip'))
        return
      const file = new File([await response.blob()], 'whale-airi.zip', { type: 'application/zip' })
      await models.initialize()
      await models.loadDisplayModelsFromIndexedDB()
      let imported = models.displayModels.find(model => model.type === 'file' && model.name === file.name)
      if (!imported)
        imported = await models.addDisplayModel(DisplayModelFormat.Live2dZip, file)
      // A user selection made during import takes precedence.
      if (modelImport.signal.aborted || !settings.stageModelSelected.startsWith('preset-'))
        return
      if (!localStorage.getItem('cohost/previous-model')) {
        localStorage.setItem('cohost/previous-model', JSON.stringify({
          model: settings.stageModelSelected,
          scale: view.scale.value,
          position: view.position.value,
          expressions: live2d.live2dExpressionEnabled,
        }))
      }
      live2d.live2dExpressionEnabled = true
      view.set('scale', 0.45)
      view.set('y', 20)
      settings.stageModelSelected = imported.id
      // Automatic installation is local to this browser profile. Do not publish
      // its generated resource ID as a user edit to the shared character card.
      await settings.updateStageModel()
      localStorage.setItem('cohost/whale-installed-v2', imported.id)
    }
    catch {
      // The local asset is optional. Keep the selected model when import fails.
      console.warn('[cohost] Local model import failed. The selected model is kept.')
    }
    finally {
      modelImporting = false
    }
  }

  onMounted(() => {
    if (connect) {
      live2d.live2dEyeTracking = false
      external = connect(receive)
      timer = setInterval(tick, 100)
      if (location.port === '5173')
        void loadLocalModel()
      return
    }
    const parentOrigin = new URLSearchParams(location.search).get('cohostOrigin')
    if (window.parent === window || !parentOrigin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(parentOrigin))
      return
    live2d.live2dEyeTracking = false
    runtime = createContext({ channel, currentWindow: window, targetWindow: () => window.parent, expectedSource: () => window.parent, expectedOrigin: parentOrigin, targetOrigin: parentOrigin })
    runtime.context.on(commandEvent, ({ body }) => receive(body))
    timer = setInterval(tick, 100)
    void loadLocalModel()
  })
  onUnmounted(() => {
    modelImport.abort()
    clearInterval(timer)
    release()
    runtime?.dispose()
    external?.dispose()
  })
}
