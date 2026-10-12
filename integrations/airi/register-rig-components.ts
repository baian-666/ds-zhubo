import type { PixiLive2DInternalModel } from '@proj-airi/stage-ui-live2d/composables/live2d'
import type { ExpressionEntry, ExpressionGroupDefinition } from '@proj-airi/stage-ui-live2d/stores/expression-store'

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
