import type { Command, Receipt } from './cohost-contract'

import { createContext } from '@moeru/eventa/adapters/window-message'
import { useSettingsLive2d } from '@proj-airi/stage-ui-live2d/composables/live2d'
import { neutralLive2DMotionControlPose, useExpressionStore, useL2dViewControl, useLive2DMotionControl } from '@proj-airi/stage-ui-live2d/stores'
import { DisplayModelFormat, useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useSettingsStageModel } from '@proj-airi/stage-ui/stores/settings/stage-model'
import { useStartupResourcesStore } from '@proj-airi/stage-ui/stores/startup-resources'
import { until } from '@vueuse/core'
import { onMounted, onUnmounted } from 'vue'

import * as v from 'valibot'

import { channel, commandEvent, commandSchema, receiptEvent } from './cohost-contract'

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
  const cards = useAiriCardStore()
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

  let expressionModel = ''
  let expressionEntries = expressions.expressions
  let expressionName: Command['name'] = 'idle'
  let nativeExpression = ''
  const expressionWrites = new Map<string, { previous: number, written: number }>()

  function restoreExpression() {
    // Restore only our writes on the same loaded model; keep user edits.
    if (expressionModel === expressions.modelId && expressionEntries === expressions.expressions) {
      for (const [id, value] of expressionWrites) {
        const entry = expressions.expressions.get(id)
        if (entry?.currentValue === value.written)
          expressions.set(id, value.previous)
      }
    }
    nativeExpression = ''
    expressionWrites.clear()
    expressionName = 'idle'
  }

  function applyExpression(name: Command['name']) {
    if (name === expressionName && expressionModel === expressions.modelId && expressionEntries === expressions.expressions)
      return
    restoreExpression()
    expressionModel = expressions.modelId
    expressionEntries = expressions.expressions
    expressionName = name
    // The local whale adapter exposes these groups. Other models keep pose control.
    const signature = [['问号', 'ParamCheek74'], ['感叹号', 'ParamCheek75'], ['开心兴奋', 'ParamCheek76'], ['生气', 'ParamCheek80']]
    if (!signature.every(([group, id]) => expressions.expressionGroups.get(group)?.parameters.some(parameter => parameter.parameterId === id)))
      return
    const groups: Partial<Record<Command['name'], string>> = { think: '问号', smile: '开心兴奋', surprise: '感叹号', pout: '生气' }
    const groupName = groups[name]
    const group = groupName && expressions.expressionGroups.get(groupName)
    if (!group)
      return
    nativeExpression = groupName
    for (const parameter of group.parameters) {
      // Audio lip sync owns mouth opening even when an expression is active.
      if (parameter.parameterId === 'ParamMouthOpenY')
        continue
      const entry = expressions.expressions.get(parameter.parameterId)
      if (!entry)
        continue
      expressionWrites.set(parameter.parameterId, { previous: entry.currentValue, written: parameter.value })
      expressions.set(parameter.parameterId, parameter.value)
    }
  }

  function release() {
    restoreExpression()
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
    const ready = !modelImporting && settings.stageModelRenderer === 'live2d'
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
      applyExpression(name)
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
        pose.headY = wave * 0.6
        pose.headZ = 0.08
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
    const receipt = { ready, name, expression: nativeExpression, session: command.session, id: command.id }
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

  async function loadLocalModel() {
    // Only the local rehearsal iframe adopts the prepared model, once per profile.
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
      await cards.updateActiveCardDisplayModel(imported.id)
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
