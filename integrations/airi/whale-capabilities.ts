import type { useExpressionStore } from '@proj-airi/stage-ui-live2d/stores/expression-store'

import type { PerformanceCapabilities } from '../../packages/cohost-contracts/performance.ts'

import { poseLimits } from '../../packages/cohost-contracts/motion.ts'
import { emptyCapabilities } from '../../packages/cohost-contracts/performance.ts'
import { componentBindings, componentFamilies, expressionAliases, isWhaleRig, nativeExpressions } from './whale-rig.ts'

type Store = Pick<ReturnType<typeof useExpressionStore>, 'modelId' | 'expressions' | 'expressionGroups' | 'isExposedToLlm' | 'llmMode'>

/** Report measured controls and current permissions. Missing parts never become advertised capabilities. */
export function whaleCapabilities(store: Store, enabled: boolean, renderer: string | undefined): PerformanceCapabilities {
  const result = emptyCapabilities(store.modelId)
  if (renderer !== 'live2d' || !isWhaleRig(store.expressionGroups))
    return result
  result.adapter = 'airi-live2d-whale-v1'
  result.presets = ['idle', 'listen', 'nod']
  result.poses = Object.keys(poseLimits) as PerformanceCapabilities['poses']
  if (!enabled)
    return result
  result.expressions = nativeExpressions.filter((name) => {
    const parameters = store.expressionGroups.get(name)?.parameters.filter(item => item.parameterId !== 'ParamMouthOpenY')
    return store.isExposedToLlm(name) && !!parameters?.length && parameters.every(item => store.expressions.has(item.parameterId))
  })
  result.aliases = Object.entries(expressionAliases).filter(([, name]) => result.expressions.includes(name)).map(([name, expression]) => ({ name: name as keyof typeof expressionAliases, expression }))
  result.presets.push(...result.aliases.map(item => item.name))
  if (store.llmMode === 'all') {
    result.components = Object.entries(componentBindings).filter(([, binding]) => store.expressions.has(binding.id)).map(([name, binding]) => ({ name, min: binding.min < 0 ? -1 : 0, max: 1, discrete: binding.switch, description: binding.description }))
    result.exclusive = componentFamilies.map(family => family.axes.filter(key => result.components.some(item => item.name === key))).filter(group => group.length > 1)
  }
  return result
}
