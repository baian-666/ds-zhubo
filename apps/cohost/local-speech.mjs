import { spawn } from 'node:child_process'
import { existsSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The Windows venv redirector must also launch a GUI-subsystem interpreter.
 * Hiding only its parent console does not prevent a detached python.exe child
 * from creating a new console. Explicit file handles still retain both logs.
 */
export function localSpeechPython(engine) {
  if(!['aqua','index'].includes(engine))throw Error('Unsupported local speech runtime')
  return fileURLToPath(new URL(engine==='index'?'../../data/indextts/repo/.venv/Scripts/pythonw.exe':'../../data/aqua-tts/.venv/Scripts/pythonw.exe',import.meta.url))
}

/** Starts installed loopback speech runtimes; concurrent callers share one startup. */
class LocalSpeechRuntime {
  constructor(engine='aqua') { this.engine=engine; this.port=engine==='index'?8794:8793 }
  async ready() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500), redirect:'error' })
      if(!response.ok)return false
      const status=await response.json()
      return status.ok===true && status.engine===(this.engine==='index'?'index-2.5':'aqua-v3')
    } catch {return false}
  }
  async ensure() {
    if(this.starting)return this.starting
    this.starting=this.start().finally(()=>{this.starting=undefined})
    return this.starting
  }
  async start() {
    if(await this.ready())return
    const root=fileURLToPath(new URL('../../',import.meta.url))
    const folder=new URL(this.engine==='index'?'../../data/indextts/':'../../data/aqua-tts/',import.meta.url)
    const python=localSpeechPython(this.engine)
    if(process.platform!=='win32'||!existsSync(python))throw Error('Local speech runtime is not installed')
    const args=[fileURLToPath(new URL(`../../scripts/${this.engine==='index'?'index':'aqua'}-service.py`,import.meta.url))]
    const profile=new URL('reference.json',folder)
    if(this.engine==='index') {
      if(!existsSync(profile))throw Error('Index voice reference is not configured')
      const settings=JSON.parse(readFileSync(profile,'utf8'))
      if(typeof settings.audio!=='string'||!existsSync(settings.audio))throw Error('Invalid Index voice reference')
      args.push('--reference',settings.audio)
    }
    if(this.engine==='aqua'&&existsSync(profile)) {
      const settings=JSON.parse(readFileSync(profile,'utf8'))
      if(typeof settings.audio!=='string'||typeof settings.promptFile!=='string')throw Error('Invalid local voice profile')
      const promptLanguage=settings.promptLanguage??'中文'
      if(!['中文','日文','英文'].includes(promptLanguage))throw Error('Invalid local reference language')
      args.push('--reference',settings.audio,'--prompt-file',settings.promptFile,'--prompt-language',promptLanguage)
      if(settings.speed!==undefined) {
        if(!Number.isFinite(settings.speed)||settings.speed<0.65||settings.speed>1.25)throw Error('Invalid local speech speed')
        args.push('--speed',String(settings.speed))
      }
      if(settings.sampleSteps!==undefined) {
        if(![4,8,16,32].includes(settings.sampleSteps))throw Error('Invalid local speech quality')
        args.push('--sample-steps',String(settings.sampleSteps))
      }
    }
    const env={...process.env,PYTHONUTF8:'1'}
    for(const name of ['DEEPSEEK_API_KEY','SILICONFLOW_API_KEY','DASHSCOPE_API_KEY'])delete env[name]
    const out=openSync(new URL('service.log',folder),'a'),err=openSync(new URL('service-error.log',folder),'a')
    let child,failed=false
    try {
      child=spawn(python,args,{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',out,err]})
      child.on('error',()=>{failed=true});child.on('exit',()=>{failed=true})
      if(child.pid)writeFileSync(new URL('service.pid',folder),String(child.pid))
      child.unref()
    } finally {closeSync(out);closeSync(err)}
    const deadline=Date.now()+75000
    while(Date.now()<deadline&&!failed) {
      if(await this.ready())return
      await new Promise(resolve=>setTimeout(resolve,250))
    }
    throw Error('Local speech startup did not complete')
  }
}

export const localSpeechRuntime=new LocalSpeechRuntime()
export const indexSpeechRuntime=new LocalSpeechRuntime('index')
