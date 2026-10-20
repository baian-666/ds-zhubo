import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useExpressionStore } from './expression-store'

beforeEach(() => {
  setActivePinia(createPinia())
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
})
afterEach(() => vi.unstubAllGlobals())
function register(id = 'whale') {
  const store = useExpressionStore()
  store.registerExpressions(id, [{ name: '笑', parameters: [{ parameterId: 'eye', blend: 'Overwrite', value: 1 }] }], [{ name: 'eye', parameterId: 'eye', blend: 'Overwrite', currentValue: 0, defaultValue: 0, modelDefault: 0, targetValue: 1 }])
  return store
}
it('keeps expression permissions across reloads and isolates models', () => {
  const store = register()
  store.setLlmMode('custom')
  store.setLlmExposed('笑', true)
  store.dispose()
  register()
  expect(store.llmMode).toBe('custom')
  expect(store.isExposedToLlm('笑')).toBe(true)
  register('other')
  expect(store.llmMode).toBe('none')
  expect(store.isExposedToLlm('笑')).toBe(false)
})
it('saves the baseline during AI performance but preserves an operator edit', () => {
  const store = register()
  store.setTransientValue('eye', 0, 1)
  store.saveDefaults()
  expect(store.expressions.get('eye')?.defaultValue).toBe(0)
  store.set('eye', 0.5)
  store.saveDefaults()
  expect(store.expressions.get('eye')?.defaultValue).toBe(0.5)
  store.dispose()
  register()
  expect(store.expressions.get('eye')?.currentValue).toBe(0.5)
})
it('records same-value manual edits and reset but does not count transient writes', () => {
  const store = register()
  store.setTransientValue('eye', 0, 1)
  expect(store.getEditRevision('eye')).toBe(0)
  store.set('eye', 1)
  expect(store.getEditRevision('eye')).toBe(1)
  store.saveDefaults()
  expect(store.expressions.get('eye')?.defaultValue).toBe(1)
  store.resetAll()
  expect(store.getEditRevision('eye')).toBe(2)
  store.dispose()
  expect(store.getEditRevision('eye')).toBe(0)
})
