import type { ExpressionEntry, ExpressionGroupDefinition } from '@proj-airi/stage-ui-live2d/stores/expression-store'

import { describe, expect, it } from 'vitest'

import { registerRigComponents } from './register-rig-components'
import { componentBindings } from './whale-rig'

const groups: ExpressionGroupDefinition[] = [['问号', 'ParamCheek74'], ['开心兴奋', 'ParamCheek76'], ['双手比耶', 'phone7'], ['蛋包饭', 'danbaofan']]
  .map(([name, id]) => ({ name, parameters: [{ parameterId: id, value: 1, blend: 'Add' }] }))

describe('measured rig component registration', () => {
  it('keeps existing expression entries and rejects mismatched ranges or another rig', () => {
    const bindings = Object.values(componentBindings)
    const core = {
      getParameterIndex: (id: string) => bindings.findIndex(binding => binding.id === id),
      getParameterCount: () => bindings.length,
      getParameterMinimumValue: (index: number) => bindings[index].min,
      getParameterMaximumValue: (index: number) => bindings[index].id === 'phone2' ? 2 : bindings[index].max,
      getParameterDefaultValue: (index: number) => bindings[index].neutral,
    }
    const existing: ExpressionEntry = { name: 'phone7', parameterId: 'phone7', blend: 'Add', modelDefault: 0, defaultValue: 0.2, currentValue: 0.2, targetValue: 1 }
    const entries = new Map([['phone7', existing]])
    registerRigComponents(core, groups, entries)
    expect(entries.get('phone7')).toBe(existing)
    expect(entries.get('phone7')?.currentValue).toBe(0.2)
    expect(entries.has('phone2')).toBe(false)
    expect(entries.get('pointX')?.blend).toBe('Overwrite')
    expect(entries.get('pointX')?.currentValue).toBe(0)
    const other = new Map<string, ExpressionEntry>()
    registerRigComponents(core, groups.slice(1), other)
    expect(other.size).toBe(0)
  })
})
