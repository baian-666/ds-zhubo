import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url)),vendor=join(root,'vendor/airi')
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:vendor,encoding:'utf8'})
if(head.status!==0||head.stdout.trim()!==JSON.parse(readFileSync(join(root,'airi.lock.json'))).commit)throw Error('Unexpected AIRI revision')
const folder='packages/stage-ui-live2d/src/composables/live2d'
for(const name of ['whale-rig.ts','register-rig-components.ts','register-rig-components.test.ts','pose-control.ts']){
  const path=join(vendor,folder,name),saved=join(root,'data/airi-rig-overlay',name),bytes=readFileSync(join(root,'integrations/airi',name))
  if(existsSync(path)&&!readFileSync(path).equals(bytes)&&(!existsSync(saved)||!readFileSync(path).equals(readFileSync(saved))))throw Error('Unsaved rig overlay: '+name)
  mkdirSync(dirname(saved),{recursive:true});if(!existsSync(path)||!readFileSync(path).equals(bytes))writeFileSync(path,bytes);writeFileSync(saved,bytes)
}
const path=join(vendor,folder,'expression-controller.ts')
let source=readFileSync(path,'utf8')
const added="import { registerRigComponents } from './register-rig-components'"
if(!source.includes(added) && !source.includes("import { applyRigPhysicsOffsets, registerRigComponents }") && !source.includes("import { registerRigComponents, RigPhysicsOffsets }")){
  const anchor="import { useExpressionStore } from '../../stores/expression-store'"
  if(!source.includes(anchor))throw Error('Expression imports changed')
  source=source.replace(anchor,anchor+'\n'+added)
}
const registration='    if (options.internalModel.value)\n      registerRigComponents(options.internalModel.value.coreModel, groups, entryMap)\n\n'
if(!source.includes('registerRigComponents(options.internalModel.value.coreModel')){
  const anchor='    store.registerExpressions('
  if(!source.includes(anchor))throw Error('Expression registration changed')
  source=source.replace(anchor,registration+anchor)
}
source=source.replace(/import \{ (?:applyRigPhysicsOffsets, )?registerRigComponents \} from '\.\/register-rig-components'/, "import { registerRigComponents, RigPhysicsOffsets } from './register-rig-components'")
if(!source.includes("import { useSettingsLive2d } from './live2d'"))source=source.replace("import { registerRigComponents, RigPhysicsOffsets }", "import { useSettingsLive2d } from './live2d'\nimport { registerRigComponents, RigPhysicsOffsets }")
if(!source.includes('  const settings = useSettingsLive2d()'))source=source.replace('  const store = useExpressionStore()', '  const store = useExpressionStore()\n  const settings = useSettingsLive2d()')
if(!source.includes('let releaseRigPhysics:'))source=source.replace('  const store = useExpressionStore()', '  const store = useExpressionStore()\n  let releaseRigPhysics: (() => void) | undefined')
const rigHook=`
    releaseRigPhysics?.()
    const internalModel = options.internalModel.value
    if (internalModel) {
      // Physics runs after motion plugins. Compose offsets at the final mesh boundary.
      const physics = new RigPhysicsOffsets(internalModel.coreModel, store)
      let lastFrame = performance.now()
      const apply = () => {
        const now = performance.now()
        physics.apply((now - lastFrame) / 1000)
        lastFrame = now
      }
      internalModel.on('beforeModelUpdate', apply)
      releaseRigPhysics = () => internalModel.off('beforeModelUpdate', apply)
    }
`
if(!source.includes("internalModel.on('beforeModelUpdate', apply)")){
  const end='      Array.from(entryMap.values()),\n    )'
  source=source.replaceAll('\r\n','\n')
  if(!source.includes(end))throw Error('Expression registration end changed')
  source=source.replace(end,end+'\n'+rigHook.trimEnd())
  source=source.replace('  function dispose() {\n    store.dispose()', '  function dispose() {\n    releaseRigPhysics?.()\n    releaseRigPhysics = undefined\n    store.dispose()')
}
source=source.replace("releaseRigPhysics = () => internalModel.off('beforeModelUpdate', apply)\n    }\n\n  }", "releaseRigPhysics = () => internalModel.off('beforeModelUpdate', apply)\n    }\n  }")
source=source.replace('      const apply = () => applyRigPhysicsOffsets(internalModel.coreModel, store)', `      const physics = new RigPhysicsOffsets(internalModel.coreModel, store)
      let lastFrame = performance.now()
      const apply = () => {
        const now = performance.now()
        physics.apply((now - lastFrame) / 1000)
        lastFrame = now
      }`)
source=source.replace('physics.apply((now - lastFrame) / 1000)', 'physics.apply((now - lastFrame) / 1000, settings.live2dIdleAnimationEnabled)')
if(readFileSync(path,'utf8')!==source)writeFileSync(path,source)
console.log('Applied measured whale rig controls.')

function patch(relative, anchor, replacement) {
  const target=join(vendor,relative),before=readFileSync(target,'utf8').replaceAll('\r\n','\n')
  if(anchor==='    // State (read-only externally, but reactive)' && before.includes('    getEditRevision,\n'))return
  if(replacement.includes("import { applyPoseParameters }") && before.includes("import { applyPoseParameters }"))return
  if(before.replace(/\s+/g,'').includes(replacement.replace(/\s+/g,'')))return
  if(!before.includes(anchor))throw Error('Performance ownership anchor changed: '+relative)
  writeFileSync(target,before.replace(anchor,replacement))
}
const controllerTest=folder+'/expression-controller.test.ts'
patch(controllerTest,"import { createPinia, setActivePinia } from 'pinia'", "import { EventEmitter } from 'node:events'\n\nimport { createPinia, setActivePinia } from 'pinia'")
patch(controllerTest,'    const internalModel = shallowRef({','    const internalModel = shallowRef(Object.assign(new EventEmitter(), {')
patch(controllerTest,'    } as unknown as PixiLive2DInternalModel)','    }) as unknown as PixiLive2DInternalModel)')
patch(controllerTest,"    expect(expressionStore.modelId).toBe('model-b')", `    expect(expressionStore.modelId).toBe('model-b')
    expect(internalModel.value.listenerCount('beforeModelUpdate')).toBe(1)
    controller.dispose()
    expect(internalModel.value.listenerCount('beforeModelUpdate')).toBe(0)`)
const store='packages/stage-ui-live2d/src/stores/expression-store.ts'
patch(store,'  // ---- internal helpers',`  // Explicit edits include same-value writes. Transient animation cannot hide operator intent.
  const editRevisions = new Map<string, number>()
  function getEditRevision(id: string) {
    return editRevisions.get(id) ?? 0
  }
  function setTransientValue(id: string, previous: number, value: number) {
    const entry = expressions.value.get(id)
    if (!entry)
      return
    markTransient(id, previous, value)
    applyValue(entry, value, undefined, true)
  }

  // ---- internal helpers`)
patch(store,'    modelId.value = id','    editRevisions.clear()\n    modelId.value = id')
patch(store,'    modelId.value = \'\'','    editRevisions.clear()\n    modelId.value = \'\'')
patch(store,'  function applyValue(entry: ExpressionEntry, value: number, duration?: number) {',`  function applyValue(entry: ExpressionEntry, value: number, duration?: number, transient = false) {
    if (!transient) {
      editRevisions.set(entry.parameterId, getEditRevision(entry.parameterId) + 1)
      clearTransient(entry.parameterId)
    }`)
patch(store,'      entry.currentValue = entry.modelDefault\n      states.push(toState(entry))','      applyValue(entry, entry.modelDefault)\n      states.push(toState(entry))')
patch(store,'    // State (read-only externally, but reactive)','    getEditRevision,\n    setTransientValue,\n    // State (read-only externally, but reactive)')
const storeText=readFileSync(join(vendor,store),'utf8')
const exportsPattern=/  return \{\r?\n(?:    (?:markTransient|clearTransient|getEditRevision|setTransientValue),\r?\n)+(?=    \/\/ State)/
writeFileSync(join(vendor,store),storeText.replace(exportsPattern,'  return {\n    markTransient,\n    clearTransient,\n    getEditRevision,\n    setTransientValue,\n').replace('  function getEditRevision(id: string) { return editRevisions.get(id) ?? 0 }','  function getEditRevision(id: string) {\n    return editRevisions.get(id) ?? 0\n  }'))
patch(store,'  function clearTransient(id: string) {',`  function isTransient(id: string) {
    const value = transientDefaults.get(id)
    return !!value && expressions.value.get(id)?.currentValue === value.written
  }
  function clearTransient(id: string) {`)
patch(store,'    markTransient,\n    clearTransient,','    markTransient,\n    isTransient,\n    clearTransient,')
const motion='packages/stage-ui-live2d/src/stores/motion-control.ts'
patch(motion,'  active: boolean\n  ownerId: string | null\n  pose:', '  active: boolean\n  ownerId: string | null\n  /** Undefined means full native joystick control. An explicit list owns only those axes. */\n  axes?: readonly (keyof Live2DMotionControlPose)[]\n  pose:')
patch(motion,"    type: 'live2d-motion-control-set'\n    ownerId: string", "    type: 'live2d-motion-control-set'\n    axes?: readonly (keyof Live2DMotionControlPose)[]\n    ownerId: string")
patch(motion,'        pose: normalizePose(event.pose),','        pose: normalizePose(event.pose),\n        axes: event.axes,')
patch(motion,'        dynamics: control.value.dynamics,','        dynamics: control.value.dynamics,\n        axes: control.value.axes,')
patch(motion,'  function setPose(ownerId: string, pose: Live2DMotionControlPose, dynamics: Live2DMotionControlDynamics) {','  function setPose(ownerId: string, pose: Live2DMotionControlPose, dynamics: Live2DMotionControlDynamics, axes?: readonly (keyof Live2DMotionControlPose)[]) {')
patch(motion,"      type: 'live2d-motion-control-set',\n      ownerId,", "      type: 'live2d-motion-control-set',\n      axes,\n      ownerId,")
const manager=folder+'/motion-manager.ts'
patch(manager,"import { useLive2DIdleEyeFocus } from './animation'", "import { useLive2DIdleEyeFocus } from './animation'\nimport { applyPoseParameters } from './pose-control'")
const contents=readFileSync(join(vendor,manager),'utf8').replaceAll('\r\n','\n')
const start=contents.indexOf('    const { eyeX, eyeY, eyeSquint, headX, headY, headZ, bodyX, bodyY, bodyZ, mouthForm, mouthOpen } = output.pose')
if(start>=0) {
  const end=contents.indexOf("    ctx.model.setParameterValueById('ParamMouthOpenY', mouthOpen)",start)
  if(end<0)throw Error('Manual pose compositor changed')
  writeFileSync(join(vendor,manager),contents.slice(0,start)+'    applyPoseParameters(ctx.model, output.pose, control.value.axes)'+contents.slice(end+"    ctx.model.setParameterValueById('ParamMouthOpenY', mouthOpen)".length))
}
