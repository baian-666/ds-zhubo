// Preparation owns no floor, chat entry, action or playback permission.
// Only an identical final transcript can transfer its result to normal participation.
const comparable = text => text.trim().replace(/[。！？!?，,；;\s]+$/u,'')
export class AnswerPreparation {
  constructor({tasks,plan,prepareSpeech,now=Date.now,timeoutMs=4500}) {
    Object.assign(this,{tasks,plan,prepareSpeech,now,timeoutMs});this.current=null;this.utterance=null;this.attempts=0;this.lastText=''
  }
  matches(id,text) {return Boolean(this.current && this.current.utterance===id && comparable(this.current.text)===comparable(text))}
  clear() {
    const item=this.current;this.current=null
    item?.controller.abort();item?.result?.replyStream?.close();item?.speech?.close()
  }
  start(snapshot) {
    const id=snapshot.latestHost.id,text=snapshot.latestHost.text
    if(this.utterance!==id){this.clear();this.utterance=id;this.attempts=0;this.lastText=''}
    if(this.current || this.attempts>=6 || this.lastText===text)return
    this.attempts++;this.lastText=text
    const item={utterance:id,text,endOfSpeechPreparation:Boolean(snapshot.endOfSpeechPreparation),startedAt:this.now(),controller:new AbortController(),result:null,speech:null,settled:false}
    this.current=item
    const task=this.tasks.start({key:`answer:${id}:${this.attempts}`,kind:'answer-preparation',signal:item.controller.signal,timeoutMs:this.timeoutMs,
      run:options=>this.plan(snapshot,options),discard:value=>value?.replyStream?.close()})
    item.done=task.done.then(outcome=>{
      if(outcome.state!=='completed' || item.controller.signal.aborted || this.current!==item){outcome.value?.replyStream?.close();return}
      const result=outcome.value
      // Only a full host reply is reusable. Waits and other actions get a fresh final review.
      if(result?.action!=='reply_host' || !['invited','spontaneous'].includes(result.hostIntent) ||
        typeof result.reason!=='string' || !result.reason.trim() || result.reason.length>180 ||
        typeof result.text!=='string' || !result.text.trim() || result.text.length>160) {result?.replyStream?.close();return}
      item.result=result;item.readyAt=this.now()
      // Only a bounded first record that the renderer cannot split is prepared.
      if(result.openingId===undefined)item.speech=this.prepareSpeech?.({preparedReply:result.text,speechStyle:result.speechStyle,streaming:true,firstSentenceOnly:Boolean(snapshot.endOfSpeechPreparation)})
    }).catch(()=>{item.result?.replyStream?.close();item.result=null}).finally(()=>{item.settled=true})
  }
  take(id,text) {
    if(!this.matches(id,text) || !this.current.settled || !this.current.result)return null
    const item=this.current;this.current=null
    if(item.speech?.failed){item.speech.close();item.speech=null}
    return item
  }
}
