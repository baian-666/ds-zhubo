import {readFileSync} from 'node:fs'

export const performanceContracts=['cohost-motion.ts','cohost-performance-capabilities.ts']
export function performanceSource(name) {
  const source=name==='cohost-motion.ts' ? 'packages/cohost-contracts/motion.ts'
    : name==='cohost-performance-capabilities.ts' ? 'packages/cohost-contracts/performance.ts'
      : 'integrations/airi/'+name
  return Buffer.from(readFileSync(new URL('../'+source,import.meta.url),'utf8')
    .replaceAll("from '../../packages/cohost-contracts/motion.ts'","from './cohost-motion'")
    .replaceAll("from '../../packages/cohost-contracts/performance.ts'","from './cohost-performance-capabilities'")
    .replaceAll("from './motion.ts'","from './cohost-motion'")
    .replaceAll("from './whale-rig.ts'","from './whale-rig'")
    .replaceAll("from './pose-control.ts'","from './pose-control'"))
}
