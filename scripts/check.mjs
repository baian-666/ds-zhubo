import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'vendor', 'node_modules', 'data'].includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) check(path)
    else if (path.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'))
    else if (path.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' })
      if (result.error || result.status !== 0) throw new Error(`Syntax check failed: ${path}`)
    }
  }
}
check('.')
console.log('JavaScript syntax and JSON checks passed.')
