import type { ExpressionEntry, ExpressionGroupDefinition, useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'

import { describe, expect, it } from 'vitest'

import { registerRigComponents, RigPhysicsOffsets } from './register-rig-components'
import { componentBindings } from './whale-rig'

const groups: ExpressionGroupDefinition[] = [['问号', 'ParamCheek74'], ['开心兴奋', 'ParamCheek76'], ['双手比耶', 'phone7'], ['蛋包饭', 'danbaofan']]
  .map(([name, id]) => ({ name, parameters: [{ parameterId: id, value: 1, blend: 'Add' }] }))

function tailFixture() {
  const ids = (['tailBase', 'tailMid', 'tailTip'] as const).map(axis => componentBindings[axis].id)
  const entries: ExpressionEntry[] = ids.map(id => ({ name: id, parameterId: id, blend: 'Overwrite', modelDefault: 0, defaultValue: 0, currentValue: 27, targetValue: 45 }))
  const owned = new Set<string>(ids)
  const revisions = new Map<string, number>()
  const store: Pick<ReturnType<typeof useExpressionStore>, 'modelId' | 'expressions' | 'expressionGroups' | 'isTransient' | 'getEditRevision' | 'llmMode'> = {
    modelId: 'whale',
    expressions: new Map(entries.map(entry => [entry.parameterId, entry])),
    expressionGroups: new Map(groups.map(group => [group.name, group])),
    isTransient: id => owned.has(id),
    getEditRevision: id => revisions.get(id) ?? 0,
    llmMode: 'all',
  }
  const values = new Map<string, number>()
  const core = {
    getParameterValueById: (key: string) => values.get(key) ?? 0,
    setParameterValueById: (key: string, value: number) => { values.set(key, value) },
  }
  const physics = new RigPhysicsOffsets(core, store)
  function frame(dt = 1 / 60, natural = -23, idle = false) {
    for (const id of ids)
      values.set(id, natural)
    values.set('ParamMouthOpenY', 0.7)
    physics.apply(dt, idle)
    return ids.map(id => (values.get(id) ?? 0) - natural)
  }
  return { ids, entries, owned, revisions, store, values, frame }
}

describe('measured rig component registration', () => {
  it('keeps a resting tail gently moving without commands or persistent parameter writes', () => {
    const fixture = tailFixture()
    fixture.owned.clear()
    for (const entry of fixture.entries)
      entry.currentValue = 0
    const samples = Array.from({ length: 480 }, () => fixture.frame(1 / 60, -23, true))
    const root = samples.map(sample => sample[0])
    expect(Math.max(...root) - Math.min(...root)).toBeGreaterThan(6)
    expect(Math.max(...root.map(Math.abs))).toBeLessThan(6)
    expect(fixture.entries.every(entry => entry.currentValue === 0)).toBe(true)
    expect(fixture.values.get('ParamMouthOpenY')).toBe(0.7)
  })

  it('settles when idle is disabled and immediately yields to manual control and revoked permissions', () => {
    const fixture = tailFixture()
    fixture.owned.clear()
    for (const entry of fixture.entries)
      entry.currentValue = 0
    for (let i = 0; i < 60; i++)
      fixture.frame(1 / 60, -23, true)
    expect(fixture.frame(1 / 60, -23, true)[0]).toBeGreaterThan(1)
    for (let i = 0; i < 120; i++)
      fixture.frame()
    expect(fixture.frame()).toEqual([0, 0, 0])
    fixture.revisions.set(fixture.ids[1], 1)
    expect(fixture.frame(1 / 60, -23, true)).toEqual([0, 0, 0])
    for (let i = 0; i < 120; i++)
      expect(fixture.frame(1 / 60, -23, true)).toEqual([0, 0, 0])
    fixture.owned.add(fixture.ids[0])
    fixture.entries[0].currentValue = 27
    expect(fixture.frame(1 / 60, -23, true)[0]).toBeGreaterThan(0)
    fixture.store.llmMode = 'none'
    expect(fixture.frame(1 / 60, -23, true)).toEqual([0, 0, 0])
  })

  it('accelerates from rest, delays the tip and preserves native physics and speech', () => {
    const fixture = tailFixture()
    const first = fixture.frame()
    expect(first[0]).toBeGreaterThan(0)
    expect(first[0]).toBeLessThan(5)
    const later = fixture.frame(0.05)
    expect(later[0]).toBeGreaterThan(later[1])
    expect(later[1]).toBeGreaterThan(later[2])
    expect(fixture.values.get('ParamMouthOpenY')).toBe(0.7)
    for (let i = 0; i < 120; i++)
      fixture.frame()
    const offset = fixture.frame()[0]
    expect(offset).toBeCloseTo(68 * Math.tanh(27 / 68), 3)
    expect(fixture.frame(0, -15)[0]).toBeCloseTo(60 * Math.tanh(27 / 60), 3)
  })

  it('reverses continuously, avoids sticking at limits and settles with a small rebound', () => {
    const fixture = tailFixture()
    for (let i = 0; i < 100; i++)
      fixture.frame()
    const before = fixture.frame()[0]
    for (const entry of fixture.entries)
      entry.currentValue = -27
    const reversal = fixture.frame()[0]
    expect(Math.abs(reversal - before)).toBeLessThan(5)
    for (let i = 0; i < 100; i++)
      fixture.frame()
    expect(fixture.frame()[0]).toBeGreaterThan(-22)
    fixture.owned.clear()
    const release = Array.from({ length: 90 }, () => fixture.frame()[0])
    expect(release[0]).toBeLessThan(-10)
    expect(Math.max(...release)).toBeGreaterThan(0.1)
    expect(Math.max(...release)).toBeLessThan(2)
    expect(release.at(-1)).toBe(0)
  })

  it('clears all momentum on manual takeover, revoked permissions and model changes', () => {
    const fixture = tailFixture()
    for (let i = 0; i < 20; i++)
      fixture.frame()
    fixture.revisions.set(fixture.ids[1], 1)
    expect(fixture.frame()).toEqual([0, 0, 0])
    expect(fixture.frame()).toEqual([0, 0, 0])
    fixture.owned.clear()
    fixture.frame()
    fixture.owned.add(fixture.ids[0])
    expect(fixture.frame()[0]).toBeGreaterThan(0)
    fixture.store.llmMode = 'none'
    expect(fixture.frame()).toEqual([0, 0, 0])
    fixture.store.llmMode = 'all'
    fixture.store.expressionGroups = new Map()
    expect(fixture.frame()).toEqual([0, 0, 0])
    fixture.store.expressionGroups = new Map(groups.map(group => [group.name, group]))
    fixture.store.modelId = 'reloaded-whale'
    expect(fixture.frame()[0]).toBeLessThan(5)
  })

  it('keeps equivalent motion at 30, 60 and 120 frames per second and rejects invalid time', () => {
    const outputs = [30, 60, 120].map((fps) => {
      const fixture = tailFixture()
      for (let i = 0; i < fps / 2; i++)
        fixture.frame(1 / fps)
      return fixture.frame(0)
    })
    for (const output of outputs) {
      for (let index = 0; index < output.length; index++)
        expect(output[index]).toBeCloseTo(outputs[0][index], 3)
    }
    const fixture = tailFixture()
    expect(fixture.frame(Number.NaN)).toEqual([0, 0, 0])
    expect(fixture.frame(-1)).toEqual([0, 0, 0])
    fixture.entries[0].blend = 'Add'
    expect(fixture.frame()[0]).toBeGreaterThan(0)
  })

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
