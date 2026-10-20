// A silent, bounded opening bank. A later ordinary director request must explicitly
// adopt an opening against the complete input before it can obtain playback rights.
const normalize = text => text.replace(/[\s，。！？!?；;：:、]/gu,'').replace(/(?<!\d)[,.]|[,.](?!\d)/gu,'')
export class OpeningPreparation {
  constructor({tasks,plan,prepareSpeech,canPrepareSpeech=()=>true,now=Date.now}) {
    Object.assign(this,{tasks,plan,prepareSpeech,canPrepareSpeech,now})
    this.items=[];this.pending=null;this.serial=0;this.nextAt=0;this.lastText='';this.starts=[]
  }
  cancelPending() {this.pending?.controller.abort();this.pending=null}
  clear() {
    this.cancelPending()
    for(const item of this.items)item.speech?.close()
    this.items=[];this.lastText=''
  }
  update(text) {
    const current=normalize(text)
    const relevant=item=>current.startsWith(normalize(item.source)) && this.now()-item.at<15000
    this.items=this.items.filter(item=>{if(relevant(item) && !item.speech?.failed)return true;item.speech?.close();return false})
    if(this.pending && !relevant(this.pending))this.cancelPending()
    this.prepareAudio()
  }
  prepareAudio() {
    const item=this.items.at(-1)
    if(!item || item.speech || !this.canPrepareSpeech() || this.items.some(value=>value.speech?.complete===false))return
    item.speech=this.prepareSpeech?.({preparedReply:item.text,speechStyle:item.speechStyle,firstSentenceOnly:true})
    if(!item.speech)this.items=this.items.filter(value=>value!==item)
  }
  offer(text) {
    this.update(text)
    const items=this.items.filter(item=>item.speech?.playable).slice(-2)
    return items.length?items.map(item=>({id:item.id,text:item.text,source:item.source})):undefined
  }
  start(snapshot) {
    const source=snapshot.latestHost.text,current=normalize(source)
    this.starts=this.starts.filter(at=>this.now()-at<60000)
    if(this.pending || this.now()<this.nextAt || this.starts.length>=12 || current.length<12 ||
      current===this.lastText || current.startsWith(this.lastText) && current.length-this.lastText.length<12)return
    this.lastText=current;this.nextAt=this.now()+4000;this.starts.push(this.now())
    const item={id:++this.serial,source,at:this.now(),controller:new AbortController()}
    this.pending=item
    const task=this.tasks.start({key:`opening:${item.id}`,kind:'opening-preparation',signal:item.controller.signal,timeoutMs:3000,
      run:options=>this.plan({...snapshot,openingPreparation:true},options),discard:value=>value?.replyStream?.close()})
    item.done=task.done.then(outcome=>{
      const result=outcome.value
      // Consume only the first sentence; never leave an unclaimed long model stream open.
      result?.replyStream?.close()
      if(outcome.state!=='completed' || this.pending!==item || item.controller.signal.aborted ||
        result?.action!=='reply_host' || typeof result.text!=='string' || result.text.length<4 || result.text.length>24)return
      this.items.push({...item,text:result.text,speechStyle:result.speechStyle})
      while(this.items.length>2)this.items.shift().speech?.close()
      this.prepareAudio()
    }).catch(()=>{}).finally(()=>{if(this.pending===item)this.pending=null})
  }
  take(id,text,reply) {
    this.update(text)
    const item=this.items.find(item=>item.id===id && item.text===reply && item.speech?.playable)
    if(!item)return undefined
    this.items=this.items.filter(value=>value!==item)
    this.clear()
    return item
  }
}
