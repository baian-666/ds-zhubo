import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('../',import.meta.url))
const vendor=join(root,'vendor/airi')
const expected=JSON.parse(readFileSync(join(root,'airi.lock.json'),'utf8')).commit
const git=args=>spawnSync('git',args,{cwd:vendor,encoding:'utf8',windowsHide:true})
if(git(['rev-parse','HEAD']).stdout?.trim()!==expected)throw Error('AIRI revision differs from airi.lock.json')
const patch=join(root,'integrations/airi/verification.patch')
if(git(['apply','--reverse','--check',patch]).status!==0) {
  if(git(['apply','--check',patch]).status!==0)throw Error('Verification patch conflicts with local edits. Nothing was reset.')
  if(git(['apply',patch]).status!==0)throw Error('Verification patch failed')
}
console.log('Applied portable AIRI verification fixtures.')
