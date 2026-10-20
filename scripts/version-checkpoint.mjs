import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { DatabaseSync, backup } from 'node:sqlite'
import { readDesktopBuild } from './desktop-artifact.mjs'

const archivePath = 'data/version-archives'
const idPattern = /^\d{8}T\d{9}Z-[a-f0-9]{8}$/
const hash = content => createHash('sha256').update(content).digest('hex')

// Check every component: following a junction could copy models or private files.
function inside(base, path) {
  const parts = path.split('/')
  if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || /[\\:\0]/.test(p)))
    throw Error('Invalid archive path')
  let result = resolve(base)
  if (lstatSync(result).isSymbolicLink()) throw Error('Archive root must not be a link')
  for (const part of parts) {
    result = join(result, part)
    if (existsSync(result) && lstatSync(result).isSymbolicLink()) throw Error('Links are not archived: ' + path)
  }
  return result
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd:root, encoding:'utf8', maxBuffer:32 * 1024 * 1024, windowsHide:true })
  if (result.error || result.status !== 0) throw Error('Git inventory failed')
  return result.stdout
}

function sources(root) {
  return [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))]
    .filter(p => !/^(data|vendor|node_modules|\.pnpm-store|\.git)\//.test(p))
    .filter(p => !/(^|\/)\.env(?:$|\.)/.test(p) || p === '.env.example')
    .filter(p => !/\.(pem|key|pfx|p12|log)$/i.test(p))
    .filter(p => existsSync(inside(root, p)))
    .sort()
}

function secrets(root) {
  const local = existsSync(join(root, '.env')) ? parseEnv(readFileSync(join(root, '.env'), 'utf8')) : {}
  return [...new Set(Object.entries({ ...process.env, ...local })
    .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value?.length >= 8)
    .map(([, value]) => value))].map(value => Buffer.from(value))
}

function tree(folder, prefix = '') {
  return readdirSync(folder, { withFileTypes:true }).flatMap(entry => {
    const path = prefix + entry.name
    const full = inside(folder, entry.name)
    if (entry.isDirectory()) return tree(full, path + '/')
    if (!entry.isFile()) throw Error('Unsupported archive entry: ' + path)
    return [path]
  }).sort()
}

function copyFiles(from, to, paths, privateValues) {
  return paths.map(path => {
    const content = readFileSync(inside(from, path))
    if (privateValues.some(value => content.includes(value))) throw Error('Credential found; archive refused: ' + path)
    const target = inside(to, path)
    mkdirSync(dirname(target), { recursive:true })
    writeFileSync(target, content, { flag:'wx' })
    return { path, bytes:content.length, sha256:hash(content) }
  })
}

function verifyFiles(folder, files) {
  if (!Array.isArray(files) || files.length === 0) throw Error('Empty file manifest')
  for (const file of files) {
    const content = readFileSync(inside(folder, file.path))
    if (content.length !== file.bytes || hash(content) !== file.sha256) throw Error('Archive file changed: ' + file.path)
  }
}

function verifyTree(folder, files) {
  verifyFiles(folder, files)
  if (JSON.stringify(tree(folder)) !== JSON.stringify(files.map(f => f.path).sort()))
    throw Error('Archive file list changed')
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag:'wx' })
}

function checkDatabase(path) {
  const db = new DatabaseSync(path, { readOnly:true })
  try {
    const rows = db.prepare('PRAGMA quick_check').all()
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw Error('Database integrity check failed')
    return db.prepare('PRAGMA user_version').get().user_version
  } finally { db.close() }
}

function preserveDesktop(root, archive, id, privateValues) {
  if (!idPattern.test(id)) throw Error('Invalid desktop version')
  const app = inside(root, 'vendor/airi/apps/stage-tamagotchi')
  const { folder, manifest:build } = readDesktopBuild(app, id)
  const destination = inside(archive, 'desktop/' + id)
  const paths = tree(folder)
  if (existsSync(destination)) {
    const record = JSON.parse(readFileSync(inside(destination, 'manifest.json'), 'utf8'))
    verifyTree(inside(destination, 'files'), record.files)
    verifyFiles(folder, record.files)
    if (JSON.stringify(paths) !== JSON.stringify(record.files.map(f => f.path))) throw Error('Desktop file list changed')
    return { id, manifestSha256:hash(readFileSync(inside(destination, 'manifest.json'))) }
  }
  const pending = destination + '.' + randomBytes(4).toString('hex') + '.pending'
  mkdirSync(join(pending, 'files'), { recursive:true })
  const files = copyFiles(folder, join(pending, 'files'), paths, privateValues)
  verifyTree(join(pending, 'files'), files)
  verifyFiles(folder, files)
  if (JSON.stringify(tree(folder)) !== JSON.stringify(paths)) throw Error('Desktop changed during capture')
  writeJson(join(pending, 'manifest.json'), { format:1, id, build, files })
  renameSync(pending, destination)
  return { id, manifestSha256:hash(readFileSync(join(destination, 'manifest.json'))) }
}

export function verifyCheckpoint(root, id) {
  if (!idPattern.test(id)) throw Error('Invalid checkpoint ID')
  const archive = inside(root, archivePath)
  const folder = inside(archive, 'checkpoints/' + id)
  return verifyFolder(archive, folder, id)
}

function verifyFolder(archive, folder, id) {
  const raw = readFileSync(inside(folder, 'manifest.json'))
  if (hash(raw) !== readFileSync(inside(folder, 'manifest.sha256'), 'utf8').trim()) throw Error('Checkpoint manifest changed')
  const manifest = JSON.parse(raw)
  if (manifest.format !== 1 || manifest.id !== id) throw Error('Invalid checkpoint manifest')
  verifyTree(inside(folder, 'source'), manifest.source)
  verifyFiles(folder, manifest.data)
  checkDatabase(inside(folder, 'session.sqlite'))
  for (const desktop of manifest.desktop.archives) {
    if (!idPattern.test(desktop.id)) throw Error('Invalid desktop version')
    const path = inside(archive, 'desktop/' + desktop.id)
    const record = readFileSync(inside(path, 'manifest.json'))
    if (hash(record) !== desktop.manifestSha256) throw Error('Desktop manifest changed')
    verifyTree(inside(path, 'files'), JSON.parse(record).files)
  }
  return { id, verified:true, sourceFiles:manifest.source.length, desktopBuilds:manifest.desktop.archives.length, database:'ok' }
}

export async function createCheckpoint(root, label = 'manual') {
  if (!label.trim() || label.length > 120) throw Error('Use a short checkpoint label')
  root = resolve(root)
  const privateValues = secrets(root)
  if (privateValues.some(value => Buffer.from(label).includes(value))) throw Error('Checkpoint label contains a credential')
  const startedAt = new Date().toISOString()
  const id = startedAt.replaceAll(/[-:.]/g, '') + '-' + randomBytes(4).toString('hex')
  const archive = inside(root, archivePath)
  mkdirSync(archive, { recursive:true })
  const pending = inside(archive, 'checkpoints/' + id + '.pending')
  mkdirSync(join(pending, 'source'), { recursive:true })
  // Capture both staged and unstaged content, including new non-ignored files.
  const paths = sources(root)
  const source = copyFiles(root, join(pending, 'source'), paths, privateValues)
  const head = git(root, ['rev-parse', 'HEAD']).trim()
  const deleted = git(root, ['ls-files', '--deleted', '-z']).split('\0').filter(Boolean)
  const pointerPath = inside(root, 'data/desktop-build.json')
  const pointerRaw = readFileSync(pointerPath)
  const pointer = JSON.parse(pointerRaw)
  if (!pointer.active) throw Error('No selected desktop build')
  const desktops = [...new Set([pointer.active, pointer.previous].filter(Boolean))]
    .map(build => preserveDesktop(root, archive, build, privateValues))
  mkdirSync(join(pending, 'dependencies'))
  const dependencyFiles = copyFiles(inside(root, 'vendor/airi'), join(pending, 'dependencies'),
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], privateValues)
  const database = new DatabaseSync(inside(root, 'data/cohost-session.sqlite'), { readOnly:true })
  try { await backup(database, join(pending, 'session.sqlite')) } finally { database.close() }
  const userVersion = checkDatabase(join(pending, 'session.sqlite'))
  const databaseBytes = readFileSync(join(pending, 'session.sqlite'))
  // Refuse a mixed snapshot if another editing/build task changed its inputs.
  verifyFiles(root, source)
  if (JSON.stringify(paths) !== JSON.stringify(sources(root)) || git(root, ['rev-parse', 'HEAD']).trim() !== head)
    throw Error('Source changed during capture; retry when edits finish')
  if (!readFileSync(pointerPath).equals(pointerRaw)) throw Error('Selected desktop changed during capture; retry')
  verifyFiles(inside(root, 'vendor/airi'), dependencyFiles)
  const manifest = {
    format:1, id, label, startedAt, completedAt:new Date().toISOString(), gitHead:head, deleted,
    source, data:[
      ...dependencyFiles.map(f => ({ ...f, path:'dependencies/' + f.path })),
      { path:'session.sqlite', bytes:databaseBytes.length, sha256:hash(databaseBytes) },
    ],
    database:{ userVersion, method:'SQLite online backup', integrity:'quick_check ok' },
    desktop:{ selected:pointer, archives:desktops, runningBuildVerified:false },
    scope:'Working tree snapshot; source, database and selected desktop builds may be from different deployment moments. No production rollback has been performed.',
    excluded:['credentials (.env)', 'desktop-profile and its imported models', 'external voice models', 'installed dependencies and toolchains', 'trial recordings and logs', 'Git history'],
  }
  writeJson(join(pending, 'manifest.json'), manifest)
  writeFileSync(join(pending, 'manifest.sha256'), hash(readFileSync(join(pending, 'manifest.json'))) + '\n', { flag:'wx' })
  const verified = verifyFolder(archive, pending, id)
  const destination = inside(archive, 'checkpoints/' + id)
  renameSync(pending, destination)
  return { ...verified, folder:destination }
}

export function listCheckpoints(root) {
  const archive = inside(root, archivePath)
  if (!existsSync(archive)) return []
  const folder = inside(archive, 'checkpoints')
  if (!existsSync(folder)) return []
  return readdirSync(folder).filter(id => idPattern.test(id)).sort().map(id => {
    const manifest = JSON.parse(readFileSync(inside(folder, id + '/manifest.json'), 'utf8'))
    return { id, label:manifest.label, completedAt:manifest.completedAt, sourceFiles:manifest.source.length, selectedDesktop:manifest.desktop.selected.active }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const [action = 'create', argument] = process.argv.slice(2)
  try {
    const result = action === 'create' ? await createCheckpoint(root, argument ?? 'manual')
      : action === 'verify' ? verifyCheckpoint(root, argument)
        : action === 'list' ? listCheckpoints(root) : null
    if (!result) throw Error('Use create [label], verify <id>, or list')
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error('Version checkpoint failed: ' + error.message)
    process.exitCode = 1
  }
}
