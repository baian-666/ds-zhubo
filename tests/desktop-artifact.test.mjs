import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { get } from 'node:http'
import { activateDesktopBuild, desktopEntryHashes, desktopRelease, readDesktopBuild, serveDesktopRenderer } from '../scripts/desktop-artifact.mjs'

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'desktop-build-test-'))
  t.after(() => rmSync(folder, { recursive:true, force:true }))
  return folder
}
function build(root, id) {
  const folder = desktopRelease(root,id)
  for (const dir of ['main','preload','renderer']) mkdirSync(join(folder,dir),{recursive:true})
  writeFileSync(join(folder,'main/index.js'),'export {}')
  writeFileSync(join(folder,'preload/index.mjs'),'export {}')
  writeFileSync(join(folder,'renderer/index.html'),'<html>ready</html>')
  writeFileSync(join(folder,'build.json'),JSON.stringify({format:1,id,entries:desktopEntryHashes(folder)}))
  return folder
}

test('desktop activation preserves the current build when a candidate is incomplete', t => {
  const root=fixture(t),pointer=join(root,'active.json')
  const first='20261015T010101000Z-12345678',second='20261015T010102000Z-abcdef12'
  build(root,first);activateDesktopBuild(pointer,root,first)
  const broken=build(root,second)
  writeFileSync(join(broken,'preload/index.mjs'),'changed')
  assert.throws(()=>activateDesktopBuild(pointer,root,second),/incomplete or changed/)
  assert.equal(JSON.parse(readFileSync(pointer)).active,first)
  assert.equal(readDesktopBuild(root,first).manifest.id,first)
})

test('desktop rollback selects an intact previous release without rebuilding',t=>{
  const root=fixture(t),pointer=join(root,'active.json')
  const first='20261015T010101000Z-12345678',second='20261015T010102000Z-abcdef12'
  build(root,first);build(root,second)
  activateDesktopBuild(pointer,root,first);activateDesktopBuild(pointer,root,second)
  const state=JSON.parse(readFileSync(pointer))
  assert.equal(state.previous,first)
  activateDesktopBuild(pointer,root,state.previous)
  assert.equal(JSON.parse(readFileSync(pointer)).active,first)
})

test('desktop build identifiers cannot escape the release directory', t=>{
  const root=fixture(t)
  for(const id of ['../outside','C:\\Windows','',null,'20261015T010101000Z-12345678/../other'])
    assert.throws(()=>desktopRelease(root,id),/Invalid desktop build ID/)
})

test('fixed renderer serves built assets and rejects source, secrets and foreign hosts',async t=>{
  const root=fixture(t),renderer=join(root,'renderer')
  mkdirSync(renderer)
  writeFileSync(join(renderer,'index.html'),'<html>ready</html>')
  writeFileSync(join(renderer,'bundle.js'),'export {}')
  writeFileSync(join(renderer,'.env'),'never serve this')
  writeFileSync(join(root,'private.txt'),'outside renderer')
  const server=await serveDesktopRenderer(renderer,{port:0,health:()=>({build:'test'})})
  t.after(()=>{server.closeAllConnections();server.close()})
  const base='http://127.0.0.1:'+server.address().port
  assert.equal(await(await fetch(base+'/')).text(),'<html>ready</html>')
  const script=await fetch(base+'/bundle.js')
  assert.equal(script.headers.get('Content-Type'),'text/javascript')
  assert.equal((await fetch(base+'/__cohost_desktop').then(r=>r.json())).build,'test')
  for(const path of ['/.env','/%2e%2e%2fprivate.txt','/%5c..%5cprivate.txt','/C:/private.txt'])
    assert.equal((await fetch(base+path)).status,403,path)
  assert.equal((await fetch(base+'/missing.js')).status,404)
  assert.equal((await fetch(base+'/%GG')).status,400)
  assert.equal((await fetch(base+'/',{method:'POST'})).status,405)
  const foreignStatus=await new Promise((accept,reject)=>get(base+'/',{headers:{host:'example.com'}},res=>{res.resume();accept(res.statusCode)}).on('error',reject))
  assert.equal(foreignStatus,403)
  assert.equal(await(await fetch(base+'/',{method:'HEAD'})).text(),'')
})

test('fixed renderer fails on an occupied port instead of changing the saved origin',async t=>{
  const root=fixture(t)
  writeFileSync(join(root,'index.html'),'ready')
  const server=await serveDesktopRenderer(root,{port:0})
  t.after(()=>{server.closeAllConnections();server.close()})
  await assert.rejects(serveDesktopRenderer(root,{port:server.address().port}),{code:'EADDRINUSE'})
})
