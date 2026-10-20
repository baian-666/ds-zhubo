import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { airiEnvironment } from './airi-toolchain.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(readFileSync(join(root, 'airi.lock.json'), 'utf8'))
const target = join(root, 'vendor', 'airi')
const action = process.argv[2]
const env = airiEnvironment()

function run(command, args, cwd = target, capture = false) {
  if (command === 'pnpm' && process.platform === 'win32') {
    const cli = process.env.PNPM_CLI_PATH || join(root, 'data/toolchains/pnpm-11.24.0/node_modules/pnpm/bin/pnpm.cjs')
    if (!existsSync(cli)) throw new Error('Install the pinned pnpm locally. See docs/LOCAL-DEVELOPMENT.md.')
    args = [cli, ...args]
    command = process.execPath
  }
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed. ${result.error?.message ?? result.stderr ?? ''}`)
  return result.stdout?.trim()
}

if (!['setup', 'setup-checks'].includes(action)) throw new Error('Use setup or setup-checks. Start the desktop with scripts/local.ps1 start:desktop.')
if (process.versions.node !== lock.node) throw new Error(`Use Node ${lock.node} from the local toolchain.`)
if (run('pnpm', ['--version'], root, true) !== lock.pnpm) throw new Error(`Use pnpm ${lock.pnpm}.`)

if (action === 'setup-checks') {
  if (run('git', ['rev-parse', 'HEAD'], target, true) !== lock.commit) throw new Error('AIRI revision differs from airi.lock.json.')
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
  run(process.execPath, [join(root,'scripts/patch-checks.mjs')], root)
} else {
  mkdirSync(target, { recursive: true })
  if (!existsSync(join(target, '.git'))) {
    run('git', ['init'])
    run('git', ['remote', 'add', 'origin', lock.repository])
  }
  const origin = run('git', ['remote', 'get-url', 'origin'], target, true)
  if (origin !== lock.repository) throw new Error('Unexpected AIRI remote. Keep the existing checkout and inspect it manually.')
  if (run('git', ['status', '--porcelain'], target, true))
    throw new Error('AIRI has local changes. Save them as reviewed patches before setup. Nothing was reset.')
  run('git', ['fetch', '--depth=1', 'origin', lock.commit])
  run('git', ['checkout', '--detach', lock.commit])
  // Dependency installation and shared builds belong to setup:desktop.
  console.log('Pinned AIRI source ready. Run scripts/local.ps1 setup:desktop, then build:desktop.')
}
