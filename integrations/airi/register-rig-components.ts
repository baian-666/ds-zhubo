import type { PixiLive2DInternalModel } from '@proj-airi/stage-ui-live2d/composables/live2d'
import type { ExpressionEntry, ExpressionGroupDefinition, useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'

import { componentBindings, isWhaleRig } from './whale-rig'

/** Registers measured controls only on the matching loaded rig, without changing its saved defaults. */
export function registerRigComponents(core: Pick<PixiLive2DInternalModel['coreModel'], 'getParameterIndex' | 'getParameterCount' | 'getParameterMinimumValue' | 'getParameterMaximumValue' | 'getParameterDefaultValue'>, groups: ExpressionGroupDefinition[], entries: Map<string, ExpressionEntry>) {
  if (!isWhaleRig(new Map(groups.map(group => [group.name, group]))))
    return
  for (const binding of Object.values(componentBindings)) {
    const index = core.getParameterIndex(binding.id)
    if (index < 0 || index >= core.getParameterCount() || entries.has(binding.id))
      continue
    if (core.getParameterMinimumValue(index) !== binding.min || core.getParameterMaximumValue(index) !== binding.max)
      continue
    const modelDefault = core.getParameterDefaultValue(index)
    entries.set(binding.id, { name: binding.id, parameterId: binding.id, blend: 'Overwrite', currentValue: modelDefault, defaultValue: modelDefault, modelDefault, targetValue: binding.max })
  }
}

type PhysicsCore = Pick<PixiLive2DInternalModel['coreModel'], 'getParameterValueById' | 'setParameterValueById'>
type PhysicsStore = Pick<ReturnType<typeof useExpressionStore>, 'modelId' | 'expressions' | 'expressionGroups' | 'isTransient' | 'getEditRevision' | 'llmMode'>

/**
 * Adds elastic gestures after native physics, once per rendered frame.
 * Each loaded model owns its simulation. Idle motion follows the local animation switch.
 * Manual edits and permission changes clear momentum immediately.
 */
export class RigPhysicsOffsets {
  private core: PhysicsCore
  private store: PhysicsStore
  private entries: PhysicsStore['expressions'] | undefined
  private model = ''
  private suppressed = false
  private idleBlocked = false
  private idleTime = 0
  // Lower frequencies and damping toward the tip give the tail a delayed, soft response.
  private segments = [
    { axis: 'tailBase' as const, frequency: 24, damping: 0.7, idleAmplitude: 4.5, position: 0, velocity: 0, revision: 0 },
    { axis: 'tailMid' as const, frequency: 18, damping: 0.65, idleAmplitude: 2.2, position: 0, velocity: 0, revision: 0 },
    { axis: 'tailTip' as const, frequency: 14, damping: 0.6, idleAmplitude: 1.1, position: 0, velocity: 0, revision: 0 },
  ]

  constructor(core: PhysicsCore, store: PhysicsStore) {
    this.core = core
    this.store = store
  }

  /** Idle is opt-in for callers. Gestures replace idle movement without changing the saved controls. */
  apply(elapsedSeconds: number, idleEnabled = false) {
    const store = this.store
    const changedModel = this.model !== store.modelId || this.entries !== store.expressions
    if (changedModel || store.llmMode !== 'all' || !isWhaleRig(store.expressionGroups)) {
      this.clear()
      this.idleBlocked = false
      this.idleTime = 0
      this.model = store.modelId
      this.entries = store.expressions
      for (const segment of this.segments)
        segment.revision = store.getEditRevision(componentBindings[segment.axis].id)
      if (store.llmMode !== 'all' || !isWhaleRig(store.expressionGroups))
        return
    }
    const owned = this.segments.some(segment => store.isTransient(componentBindings[segment.axis].id))
    const edited = this.segments.some(segment => segment.revision !== store.getEditRevision(componentBindings[segment.axis].id))
    if (edited) {
      this.clear()
      this.idleBlocked = true
      this.suppressed = owned
      for (const segment of this.segments)
        segment.revision = store.getEditRevision(componentBindings[segment.axis].id)
      return
    }
    if (this.suppressed) {
      this.suppressed = owned
      return
    }
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)
      return
    // A suspended renderer must not replay old momentum when its window returns.
    if (elapsedSeconds > 0.25)
      this.clear()
    const duration = Math.min(elapsedSeconds, 0.05)
    const startTime = this.idleTime
    this.idleTime += duration
    if (owned)
      this.idleBlocked = false
    const idle = idleEnabled && !owned && !this.idleBlocked && this.segments.every((segment) => {
      const entry = store.expressions.get(componentBindings[segment.axis].id)
      return !entry || entry.currentValue === (entry.blend === 'Add' ? 0 : entry.modelDefault)
    })
    const steps = Math.max(1, Math.ceil(duration * 240))
    const dt = duration / steps
    for (const [index, segment] of this.segments.entries()) {
      const binding = componentBindings[segment.axis]
      const entry = store.expressions.get(binding.id)
      if (!entry) {
        segment.position = 0
        segment.velocity = 0
        continue
      }
      const gestureTarget = store.isTransient(binding.id)
        ? entry.currentValue - (entry.blend === 'Add' ? 0 : entry.modelDefault)
        : 0
      let target = gestureTarget
      for (let step = 0; step < steps; step++) {
        if (idle) {
          // Small layered waves travel from root to tip. Idle never writes expression defaults or starts a director action.
          const time = startTime + (step + 1) * dt
          const phase = time * Math.PI * 2 / 4.8 - index * 0.45
          target = segment.idleAmplitude * (Math.sin(phase) + 0.1 * Math.sin(time * Math.PI * 2 / 8.7 - index * 0.3))
        }
        const acceleration = segment.frequency ** 2 * (target - segment.position)
          - 2 * segment.damping * segment.frequency * segment.velocity
        segment.velocity += acceleration * dt
        segment.position += segment.velocity * dt
      }
      if (Math.abs(target - segment.position) < 0.01 && Math.abs(segment.velocity) < 0.05) {
        segment.position = target
        segment.velocity = 0
      }
      if (segment.position === 0)
        continue
      const natural = this.core.getParameterValueById(binding.id)
      // Compress the available range smoothly. Hard clipping makes a tail stick at its limit.
      const headroom = Math.max(0, segment.position > 0 ? binding.max - natural : natural - binding.min)
      const offset = headroom > 0 ? headroom * Math.tanh(segment.position / headroom) : 0
      this.core.setParameterValueById(binding.id, natural + offset)
    }
  }

  private clear() {
    this.suppressed = false
    for (const segment of this.segments) {
      segment.position = 0
      segment.velocity = 0
    }
  }
}
