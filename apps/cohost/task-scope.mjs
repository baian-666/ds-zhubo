import { randomUUID } from 'node:crypto'

const terminal = state => ['completed','cancelled','failed'].includes(state)
const reasons = new Set(['cancelled','superseded','reset','closed','parent','timeout','capacity','error'])

/** Owned, bounded work; deliberately knows nothing about turns, speech or providers.
 * Cancelling releases the caller immediately, but an uncooperative worker still
 * occupies its physical slot until it settles. Late resources go to discard.
 */
export class TaskScope {
  constructor({name,maxRunning=1,maxWaiting=1,historyLimit=24,pollMs=1000,now=Date.now}={}) {
    for(const value of [maxRunning,maxWaiting,historyLimit,pollMs])if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid task bound')
    Object.assign(this,{name,maxRunning,maxWaiting,historyLimit,pollMs,now})
    this.generation=randomUUID();this.tasks=new Set();this.history=[];this.closed=false;this.timer=null
  }
  start({key,kind,run,signal,delayMs=0,timeoutMs=30000,maxTimeoutMs=timeoutMs,ready=()=>true,discard=()=>{}}) {
    if(!Number.isFinite(delayMs)||delayMs<0||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('Invalid task timing')
    const duplicate=[...this.tasks].find(task=>task.key===key&&!terminal(task.state))
    if(duplicate)return duplicate.handle
    let resolve
    const task={id:randomUUID(),key,kind,generation:this.generation,state:'waiting',createdAt:this.now(),
      startedAt:null,finishedAt:null,reason:null,controller:new AbortController(),running:false,
      notBefore:this.now()+delayMs,run,ready,discard,resolve:value=>resolve(value)}
    if(!Number.isFinite(maxTimeoutMs)||maxTimeoutMs<timeoutMs)throw new Error('Invalid task maximum timeout')
    task.extendTimeout=ms=>{
      if(terminal(task.state) || !Number.isFinite(ms) || ms<timeoutMs || ms>maxTimeoutMs)return false
      clearTimeout(task.timeout)
      task.timeout=setTimeout(()=>{this.finish(task,'failed','timeout');this.pump()},Math.max(0,task.createdAt+ms-this.now()))
      return true
    }
    const done=new Promise(r=>{resolve=r})
    task.handle={id:task.id,controller:task.controller,done,cancel:reason=>this.cancel(task,reason),get state(){return task.state}}
    if(this.closed) {this.finish(task,'cancelled','closed');return task.handle}
    if([...this.tasks].filter(x=>x.state==='waiting').length>=this.maxWaiting) {this.finish(task,'failed','capacity');return task.handle}
    this.tasks.add(task)
    if(signal) {
      task.parent=signal;task.onAbort=()=>this.cancel(task,'parent')
      signal.addEventListener('abort',task.onAbort,{once:true})
      if(signal.aborted)task.onAbort()
    }
    if(!terminal(task.state)) {
      task.extendTimeout(timeoutMs)
      this.pump()
    }
    return task.handle
  }
  finish(task,state,reason=null,payload={}) {
    if(terminal(task.state))return false
    task.state=state;task.reason=reasons.has(reason)?reason:reason===null?null:'error';task.finishedAt=this.now()
    clearTimeout(task.timeout)
    task.parent?.removeEventListener('abort',task.onAbort)
    if(state!=='completed')task.controller.abort()
    if(!task.running)this.tasks.delete(task)
    this.history.push(this.record(task));this.history=this.history.slice(-this.historyLimit)
    task.resolve({state,reason:task.reason,...payload})
    return true
  }
  cancel(task,reason='cancelled') {
    const changed=this.finish(task,'cancelled',reason)
    this.pump();return changed
  }
  async discard(task,value) {
    // Cleanup failures must not resurrect work or become unhandled rejections.
    try {await task.discard(value)} catch {}
  }
  launch(task) {
    task.state='running';task.running=true;task.startedAt=this.now()
    let work
    try {work=task.run({signal:task.controller.signal,extendTimeout:task.extendTimeout})} catch(error) {work=Promise.reject(error)}
    Promise.resolve(work).then(async value=>{
      if(!this.finish(task,'completed',null,{value}))await this.discard(task,value)
    },error=>{this.finish(task,'failed','error',{error})}).finally(()=>{
      task.running=false;this.tasks.delete(task);this.pump()
    })
  }
  pump() {
    clearTimeout(this.timer);this.timer=null
    if(this.closed)return
    let running=[...this.tasks].filter(task=>task.running).length
    for(const task of this.tasks) {
      if(task.state!=='waiting'||running>=this.maxRunning||this.now()<task.notBefore)continue
      let ready
      try {ready=task.ready()} catch(error) {this.finish(task,'failed','error',{error});continue}
      if(ready){running++;this.launch(task)}
    }
    const waiting=[...this.tasks].filter(task=>task.state==='waiting')
    if(waiting.length) {
      const delay=Math.min(this.pollMs,...waiting.map(task=>task.notBefore>this.now()?task.notBefore-this.now():this.pollMs))
      this.timer=setTimeout(()=>this.pump(),Math.max(1,delay));this.timer.unref?.()
    }
  }
  reset(reason='reset') {
    this.generation=randomUUID()
    // Cancel all before pumping; a queued old task must never start mid-reset.
    for(const task of this.tasks)this.finish(task,'cancelled',reason)
    this.pump()
  }
  close() {if(this.closed)return;this.closed=true;this.reset('closed');clearTimeout(this.timer);this.timer=null}
  record(task) {
    return {id:task.id,kind:task.kind,generation:task.generation,state:task.state,reason:task.reason,
      createdAt:task.createdAt,startedAt:task.startedAt,finishedAt:task.finishedAt}
  }
  status() {
    return {owner:this.name,generation:this.generation,closed:this.closed,
      limits:{running:this.maxRunning,waiting:this.maxWaiting},
      waiting:[...this.tasks].filter(task=>task.state==='waiting').length,
      running:[...this.tasks].filter(task=>task.state==='running').length,
      draining:[...this.tasks].filter(task=>task.running&&terminal(task.state)).length,
      active:[...this.tasks].filter(task=>!terminal(task.state)).map(task=>this.record(task)),recent:this.history.map(record=>({...record}))}
  }
}
