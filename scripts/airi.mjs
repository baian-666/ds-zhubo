import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(readFileSync(join(root, 'airi.lock.json'), 'utf8'))
const target = join(root, 'vendor', 'airi')
const action = process.argv[2]

function run(command, args, cwd = target, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed. ${result.error?.message ?? result.stderr ?? ''}`)
  return result.stdout?.trim()
}

if (!['setup', 'dev'].includes(action)) throw new Error('Use setup or dev.')
if (process.platform === 'win32') throw new Error('Run the AIRI setup in the Linux dev container or Codespaces.')
if (process.versions.node !== lock.node) throw new Error(`Use Node ${lock.node} from the dev container.`)
if (run('pnpm', ['--version'], root, true) !== lock.pnpm) throw new Error(`Use pnpm ${lock.pnpm}.`)

if (action === 'setup') {
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
  run('pnpm', ['install', '--frozen-lockfile'])
} else {
  if (!existsSync(join(target, '.git'))) throw new Error('Run npm run setup:airi first.')
  if (run('git', ['rev-parse', 'HEAD'], target, true) !== lock.commit) throw new Error('AIRI revision differs from airi.lock.json.')
  // Vite accepts only the current private Codespaces host, rather than every host.
  if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN)
    process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = `${process.env.CODESPACE_NAME}-5173.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
  run('pnpm', ['-F', '@proj-airi/stage-web', 'dev', '--port', '5173', '--strictPort'])
}
