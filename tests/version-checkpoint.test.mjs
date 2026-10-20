import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createCheckpoint, listCheckpoints, verifyCheckpoint } from '../scripts/version-checkpoint.mjs'
import { desktopEntryHashes } from '../scripts/desktop-artifact.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cohost-version-'))
  let db
  t.after(() => {
    db?.close()
    rmSync(root, { recursive:true, force:true })
  })
  function put(path, content) {
    mkdirSync(join(root, path, '..'), { recursive:true })
    writeFileSync(join(root, path), content)
  }
  for (const args of [['init'], ['config', 'user.name', 'Checkpoint Test'], ['config', 'user.email', 'checkpoint@example.invalid']]) {
    assert.equal(spawnSync('git', args, { cwd:root, windowsHide:true }).status, 0)
  }
  put('.gitignore', 'data/\nvendor/\n.env\n')
  put('kept.mjs', 'export const version = 1\n')
  put('deleted.mjs', 'export {}\n')
  spawnSync('git', ['add', '.'], { cwd:root, windowsHide:true })
  assert.equal(spawnSync('git', ['commit', '-m', 'fixture'], { cwd:root, windowsHide:true }).status, 0)
  put('kept.mjs', 'export const version = 2\n')
  put('new.mjs', 'export const added = true\n')
  rmSync(join(root, 'deleted.mjs'))
  put('.env', 'CHECKPOINT_TEST_TOKEN=private-version-fixture-547172\n')
  const desktop = '20261020T120000000Z-1234abcd'
  const build = 'vendor/airi/apps/stage-tamagotchi/out/cohost-builds/' + desktop
  for (const path of ['main/index.js', 'preload/index.mjs', 'renderer/index.html']) put(build + '/' + path, 'fixture')
  put(build + '/renderer/asset.js', 'export const asset = true\n')
  put(build + '/build.json', JSON.stringify({ format:1, id:desktop, entries:desktopEntryHashes(join(root, build)) }))
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) put('vendor/airi/' + path, '{}')
  put('data/desktop-build.json', JSON.stringify({ active:desktop, previous:null }))
  db = new DatabaseSync(join(root, 'data/cohost-session.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES (\'retained\')')
  return { root, put, db, desktop }
}

test('checkpoint retains dirty and new source, deleted paths, WAL data, and desktop assets independently of live files', async t => {
  const { root, put, desktop } = fixture(t)
  const saved = await createCheckpoint(root, 'before-change')
  const manifest = JSON.parse(readFileSync(join(saved.folder, 'manifest.json')))
  assert.equal(saved.verified, true)
  assert.ok(manifest.deleted.includes('deleted.mjs'))
  assert.ok(manifest.source.some(f => f.path === 'new.mjs'))
  assert.ok(!manifest.source.some(f => f.path === '.env' || f.path.startsWith('data/')))
  assert.equal(readFileSync(join(saved.folder, 'source/kept.mjs'), 'utf8'), 'export const version = 2\n')
  const restored = new DatabaseSync(join(saved.folder, 'session.sqlite'), { readOnly:true })
  try { assert.equal(restored.prepare('SELECT text FROM messages').get().text, 'retained') } finally { restored.close() }
  put('kept.mjs', 'later change')
  put('vendor/airi/apps/stage-tamagotchi/out/cohost-builds/' + desktop + '/renderer/asset.js', 'later asset')
  assert.equal(verifyCheckpoint(root, saved.id).verified, true)
  assert.equal(listCheckpoints(root)[0].label, 'before-change')
})

test('checkpoint verification detects archived asset corruption and reuses an intact build only once', async t => {
  const { root, desktop } = fixture(t)
  const first = await createCheckpoint(root, 'first')
  await createCheckpoint(root, 'second')
  assert.equal(readdirSync(join(root, 'data/version-archives/desktop')).length, 1)
  writeFileSync(join(root, 'data/version-archives/desktop', desktop, 'files/renderer/asset.js'), 'corrupt')
  assert.throws(() => verifyCheckpoint(root, first.id), /Archive file changed/)
})

test('checkpoint verification rejects extra files and a modified checkpoint manifest', async t => {
  const { root } = fixture(t)
  const saved = await createCheckpoint(root, 'integrity')
  const unexpected = join(saved.folder, 'source/unlisted.mjs')
  writeFileSync(unexpected, 'unlisted')
  assert.throws(() => verifyCheckpoint(root, saved.id), /Archive file list changed/)
  rmSync(unexpected)
  writeFileSync(join(saved.folder, 'manifest.json'), '{}')
  assert.throws(() => verifyCheckpoint(root, saved.id), /Checkpoint manifest changed/)
})

test('a credential accidentally pasted into source refuses publication without exposing the value', async t => {
  const { root, put } = fixture(t)
  put('new.mjs', 'private-version-fixture-547172')
  await assert.rejects(createCheckpoint(root, 'leak'), error => /Credential found/.test(error.message) && !error.message.includes('547172'))
  assert.deepEqual(listCheckpoints(root), [])
})

test('checkpoint rejects directory junctions and traversal paths', async t => {
  const { root } = fixture(t)
  const outside = mkdtempSync(join(tmpdir(), 'cohost-version-outside-'))
  t.after(() => rmSync(outside, { recursive:true, force:true }))
  symlinkSync(outside, join(root, 'data/version-archives'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createCheckpoint(root), /Links are not archived/)
  assert.throws(() => verifyCheckpoint(root, '../outside'), /Invalid checkpoint ID/)
  assert.deepEqual(readdirSync(outside), [])
})
