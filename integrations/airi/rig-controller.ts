import type { useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'

import type { SequenceExpression } from './motion-sequence'
import type { Components, NativeExpression } from './whale-rig'

// The Node regression tests and AIRI use the same controller contract.
import { componentBindings, expressionAliases, faceExpressions, glassesExpressions, handAxes, handExpressions, isWhaleRig, nativeExpressions, stickerExpressions } from './whale-rig.ts'

type Store = Pick<ReturnType<typeof useExpressionStore>, 'modelId' | 'expressions' | 'expressionGroups' | 'set'>
/** A transient rig lease. Restore only unchanged writes; operator edits win until the lease ends. */
export class RigController {
  private model = ''
  private entries: Store['expressions'] | undefined
  private writes = new Map<string, { previous: number, written: number }>()
  private blocked = new Set<string>()

  private store: Store

  constructor(store: Store) { this.store = store }

  restore() {
    if (this.model === this.store.modelId && this.entries === this.store.expressions) {
      for (const [id, value] of this.writes) {
        if (this.store.expressions.get(id)?.currentValue === value.written)
          this.store.set(id, value.previous)
      }
    }
    this.writes.clear()
    this.blocked.clear()
    this.entries = undefined
  }

  apply(expression: SequenceExpression | undefined, components: Components): string {
    if (this.model !== this.store.modelId || this.entries !== this.store.expressions) {
      this.restore()
      this.model = this.store.modelId
      this.entries = this.store.expressions
    }
    if (!isWhaleRig(this.store.expressionGroups))
      return ''
    const targets = new Map<string, number>()
    const name = expression && (Object.hasOwn(expressionAliases, expression.name) ? expressionAliases[expression.name as keyof typeof expressionAliases] : expression.name)
    const group = name && nativeExpressions.includes(name as NativeExpression) ? this.store.expressionGroups.get(name) : undefined
    if (group && expression && expression.strength > 0) {
      // Clear competing drawings for this family, without clearing unrelated accessories.
      for (const family of [faceExpressions, handExpressions, glassesExpressions, stickerExpressions]) {
        if (!family.includes(group.name))
          continue
        for (const member of family) {
          for (const parameter of this.store.expressionGroups.get(member)?.parameters ?? []) {
            if (parameter.parameterId === 'ParamMouthOpenY')
              continue
            const entry = this.store.expressions.get(parameter.parameterId)
            if (entry)
              targets.set(parameter.parameterId, entry.blend === 'Overwrite' ? entry.modelDefault : entry.blend === 'Multiply' ? 1 : 0)
          }
        }
      }
      if (handExpressions.includes(group.name)) {
        for (const axis of handAxes)
          this.targetComponent(targets, axis, 0)
      }
      for (const parameter of group.parameters) {
        const id = parameter.parameterId
        if (id === 'ParamMouthOpenY')
          continue
        const entry = this.store.expressions.get(id)
        if (!entry)
          continue
        // Authored eyelid values switch with the replacement drawing, preventing double eyes.
        const smooth = /^(?:ParamBrow|ParamMouthForm)/.test(id)
        const previous = this.writes.get(id)?.previous ?? entry.currentValue
        targets.set(id, smooth ? previous + (parameter.value - previous) * expression.strength : parameter.value)
      }
    }
    // Explicit component targets override a group affecting the same parameter.
    for (const [axis, value] of Object.entries(components))
      this.targetComponent(targets, axis as keyof Components, value)
    for (const [id, write] of this.writes) {
      const entry = this.store.expressions.get(id)
      if (entry?.currentValue !== write.written) {
        this.blocked.add(id)
        this.writes.delete(id)
      }
      else if (!targets.has(id)) {
        this.store.set(id, write.previous)
        this.writes.delete(id)
      }
    }
    for (const [id, written] of targets) {
      const entry = this.store.expressions.get(id)
      if (!entry || this.blocked.has(id))
        continue
      this.writes.set(id, { previous: this.writes.get(id)?.previous ?? entry.currentValue, written })
      this.store.set(id, written)
    }
    return group && expression && expression.strength > 0 ? group.name : ''
  }

  private targetComponent(targets: Map<string, number>, axis: keyof Components, amount: number) {
    const binding = componentBindings[axis]
    const entry = this.store.expressions.get(binding.id)
    if (!entry)
      return
    const value = binding.min < 0 ? amount * binding.max : binding.min + amount * (binding.max - binding.min)
    // Existing exp3 entries are additive offsets; newly registered entries use absolute values.
    targets.set(binding.id, entry.blend === 'Add' ? value - entry.modelDefault : value)
  }
}
