import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url)),vendor=join(root,'vendor/airi')
const head=spawnSync('git',['rev-parse','HEAD'],{cwd:vendor,encoding:'utf8'})
if(head.status!==0||head.stdout.trim()!==JSON.parse(readFileSync(join(root,'airi.lock.json'))).commit)throw Error('Unexpected AIRI revision')
const folder='packages/stage-ui-live2d/src/composables/live2d'
for(const name of ['whale-rig.ts','register-rig-components.ts','register-rig-components.test.ts']){
  const path=join(vendor,folder,name),saved=join(root,'data/airi-rig-overlay',name),bytes=readFileSync(join(root,'integrations/airi',name))
  if(existsSync(path)&&!readFileSync(path).equals(bytes)&&(!existsSync(saved)||!readFileSync(path).equals(readFileSync(saved))))throw Error('Unsaved rig overlay: '+name)
  mkdirSync(dirname(saved),{recursive:true});if(!existsSync(path)||!readFileSync(path).equals(bytes))writeFileSync(path,bytes);writeFileSync(saved,bytes)
}
const path=join(vendor,folder,'expression-controller.ts')
let source=readFileSync(path,'utf8')
const added="import { registerRigComponents } from './register-rig-components'"
if(!source.includes(added)){
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
if(readFileSync(path,'utf8')!==source)writeFileSync(path,source)
console.log('Applied measured whale rig controls.')
