import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { localSpeechPython } from '../apps/cohost/local-speech.mjs'

if(process.platform!=='win32')throw Error('This check requires Windows')
const folder=mkdtempSync(join(tmpdir(),'cohost-speech-launch-'))
try {
  const fixture=join(folder,'probe.py'),result=join(folder,'result.json')
  writeFileSync(fixture,`import ctypes, importlib.util, json, os, sys
from pathlib import Path
assert sys.stdout is not None and sys.stderr is not None
print("stdout probe", flush=True)
print("stderr probe", file=sys.stderr, flush=True)
Path(sys.argv[1]).write_text(json.dumps({"consoleWindow": ctypes.windll.kernel32.GetConsoleWindow(), "prefix": sys.prefix, "executable": sys.executable, "torchInstalled": importlib.util.find_spec("torch") is not None}), encoding="utf-8")
`)
  for(const engine of ['index','aqua']) {
    const python=localSpeechPython(engine)
    assert.ok(existsSync(python))
    const outPath=join(folder,'stdout.log'),errPath=join(folder,'stderr.log')
    const out=openSync(outPath,'w'),err=openSync(errPath,'w')
    let child
    try {child=spawn(python,[fixture,result],{detached:true,windowsHide:true,stdio:['ignore',out,err],env:{...process.env,PYTHONUTF8:'1'}})}
    finally {closeSync(out);closeSync(err)}
    const [code]=await once(child,'exit')
    assert.equal(code,0)
    const probe=JSON.parse(readFileSync(result,'utf8'))
    assert.equal(probe.consoleWindow,0,'background speech must not own a console')
    assert.equal(resolve(probe.prefix).toLowerCase(),resolve(dirname(dirname(python))).toLowerCase())
    assert.equal(probe.torchInstalled,true)
    assert.match(readFileSync(outPath,'utf8'),/stdout probe/)
    assert.match(readFileSync(errPath,'utf8'),/stderr probe/)
    console.log(JSON.stringify({engine,consoleWindow:0,venvPreserved:true,stdoutCaptured:true,stderrCaptured:true,modelLoaded:false}))
  }
} finally {
  assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep))
  rmSync(folder,{recursive:true,force:true})
}
