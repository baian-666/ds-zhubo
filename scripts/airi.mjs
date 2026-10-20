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

if (!['setup', 'setup-web', 'setup-checks', 'dev'].includes(action)) throw new Error('Use setup, setup-web, setup-checks or dev.')
if (process.versions.node !== lock.node) throw new Error(`Use Node ${lock.node} from the local toolchain.`)
if (run('pnpm', ['--version'], root, true) !== lock.pnpm) throw new Error(`Use pnpm ${lock.pnpm}.`)

if (action === 'setup-checks') {
  if (run('git', ['rev-parse', 'HEAD'], target, true) !== lock.commit) throw new Error('AIRI revision differs from airi.lock.json.')
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])
  run(process.execPath, [join(root,'scripts/patch-checks.mjs')], root)
} else if (action === 'setup' || action === 'setup-web') {
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
  if (action === 'setup-web' || process.platform === 'win32') {
    run('pnpm', ['--filter', '@proj-airi/stage-web...', 'install', '--frozen-lockfile', '--ignore-scripts'])
    run('pnpm', ['-r', '--filter', '@proj-airi/stage-web^...', '--workspace-concurrency=2', '--if-present', 'run', 'build'])
  } else run('pnpm', ['install', '--frozen-lockfile'])
} else {
  if (!existsSync(join(target, '.git'))) throw new Error('Run npm run setup:airi first.')
  if (run('git', ['rev-parse', 'HEAD'], target, true) !== lock.commit) throw new Error('AIRI revision differs from airi.lock.json.')
  // Vite accepts only the current private Codespaces host, rather than every host.
  if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN)
    env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = `${process.env.CODESPACE_NAME}-5173.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
  run(process.execPath, [join(root,'scripts/patch-airi.mjs')], root)
  run('pnpm', ['-F', '@proj-airi/stage-web', 'exec', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'])
}
