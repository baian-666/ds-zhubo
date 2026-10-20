import { PcmOnset } from './pcm-onset.mjs'

/** One speculative sentence owns its bounded PCM until a candidate transfers it to a turn. */
export class PreparedSpeech {
  static firstSentence(speech,text,speechStyle,now=Date.now) {
    // The renderer flushes each model record. With at most 24 source characters
    // and no internal hard boundary, its word limit cannot split this exact record.
    if(typeof text!=='string' || text!==text.trim() || !text || text.length>24 || /[\u200B\u2063\r\n\t]/u.test(text) ||
      !/^[^。.!！?？…⋯～~]+[。.!！?？…⋯～~]*[”’"'」』》】）)\]}]*$/u.test(text))return undefined
    return new PreparedSpeech(speech,text,speechStyle,now,{streaming:true,trimStart:true})
  }
  constructor(speech, text, speechStyle, now=Date.now, {streaming=false,trimStart=false}={}) {
    this.text=text;this.revision=speech.revision;this.controller=new AbortController()
    this.streaming=streaming;this.waiters=new Set();this.complete=false
    this.onset=trimStart?new PcmOnset():null;this.playableBytes=0
    this.preparationTimer=setTimeout(()=>this.controller.abort(),8000);this.preparationTimer.unref?.()
    this.frames=[];this.bytes=0;this.ready=false;this.failed=false;this.startedAt=now()
    this.done=speech.stream(text,{speechStyle,signal:this.controller.signal,emit:event=>{
      if(this.controller.signal.aborted)return
      if(event.type==='audio') {
        this.firstPcmAt??=now();this.bytes+=Buffer.byteLength(event.pcm,'base64')
        if(this.bytes>(streaming?6_000_000:1_000_000))throw Error('Prepared speech limit')
        if(this.onset){event=this.onset.accept(event);if(!event)return}
        this.playableBytes+=Buffer.byteLength(event.pcm,'base64')
      }
      this.frames.push(event)
      this.wake()
    }}).then(()=>{
      if(this.controller.signal.aborted)return
      if(!this.playableBytes)throw Error('Prepared speech is empty')
      if(!streaming)this.trimSilence()
      this.ready=true
    }).catch(()=>{this.failed=true;this.frames=[]}).finally(()=>{clearTimeout(this.preparationTimer);this.complete=true;this.wake()})
  }
  wake() {for(const resolve of this.waiters)resolve();this.waiters.clear()}
  get playable() {return !this.failed && !this.controller.signal.aborted && (this.ready || (this.streaming && this.playableBytes>=4800))}
  trimSilence() {
    const audio=this.frames.filter(frame=>frame.type==='audio')
    const rate=audio[0].sampleRate
    if(audio.some(frame=>frame.sampleRate!==rate))throw Error('Prepared audio rate changed')
    const pcm=Buffer.concat(audio.map(frame=>Buffer.from(frame.pcm,'base64')))
    // Keep 40 ms before and 80 ms after audible samples, including quiet consonants.
    let first=0,last=pcm.length/2-1
    while(first<last && Math.abs(pcm.readInt16LE(first*2))<32)first++
    while(last>first && Math.abs(pcm.readInt16LE(last*2))<32)last--
    first=Math.max(0,first-Math.ceil(rate*0.04));last=Math.min(pcm.length/2-1,last+Math.ceil(rate*0.08))
    this.durationMs=(last+1-first)*1000/rate
    this.frames=[{type:'audio',sampleRate:rate,pcm:pcm.subarray(first*2,(last+1)*2).toString('base64')},{type:'done'}]
  }
  replay(text, {signal,turnSignal,emit}) {
    if(this.streaming) {
      if(text!==this.text || this.claimed)throw Error('Prepared speech is unavailable')
      // Once adopted, the ordinary speech provider deadline owns the stream.
      clearTimeout(this.preparationTimer)
      this.claimed=true
      const combined=AbortSignal.any([this.controller.signal,...[signal,turnSignal].filter(Boolean)])
      const wake=()=>this.wake()
      combined.addEventListener('abort',wake,{once:true})
      return (async()=>{let index=0
      try {
        for(;;) {
          combined.throwIfAborted()
          if(this.failed)throw Error('Prepared speech failed')
          while(index<this.frames.length) {combined.throwIfAborted();emit(this.frames[index++])}
          if(this.complete)return
          await new Promise(resolve=>this.waiters.add(resolve))
        }
      } finally {combined.removeEventListener('abort',wake)}
      })()
    }
    if(text!==this.text || !this.ready || this.controller.signal.aborted)throw Error('Prepared speech is unavailable')
    for(const event of this.frames) {
      if(signal?.aborted || turnSignal?.aborted || this.controller.signal.aborted)throw Error('Prepared speech cancelled')
      emit(event)
    }
  }
  close() {clearTimeout(this.preparationTimer);this.controller.abort();this.frames=[];this.onset=null;this.ready=false;this.wake()}
}
