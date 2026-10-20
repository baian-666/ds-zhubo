/** Ephemeral ASR evidence. It never writes chat history or declares a completed host turn. */
export class LiveListening {
  constructor({now=Date.now,settleMs=500,intervalMs=1000,leaseMs=700}={}) {
    Object.assign(this,{now,settleMs,intervalMs,leaseMs});this.reset()
  }
  reset() {this.text='';this.confirmed='';this.samples=[];this.reviewed='';this.answered='';this.nextAt=0;this.pauseAt=null;this.quietSince=null;this.updatedAt=0}
  update(text,confirmed='') {
    if(text===this.text && confirmed===this.confirmed)return
    this.text=text;this.confirmed=confirmed
    this.updatedAt=this.now()
    this.samples.push({text,at:this.now()})
    // Retain an old sample for prefix stability and a bounded recent window.
    while(this.samples.length>2 && this.samples[1].at<=this.now()-this.settleMs)this.samples.shift()
    if(this.samples.length>32)this.samples.splice(1,this.samples.length-32)
  }
  pause(value) {this.pauseAt=value?this.now():null;this.quietSince=value?(this.quietSince??this.now()):null}
  get quiet(){return this.pauseAt!==null && this.now()-this.pauseAt<=this.leaseMs}
  offer() {
    if(!this.text || this.now()<this.nextAt)return null
    const old=this.samples.findLast(sample=>sample.at<=this.now()-this.settleMs)
    let prefix=this.confirmed
    if(old && this.now()-old.at>=this.settleMs) {
      let length=0
      while(length<old.text.length && old.text[length]===this.text[length])length++
      if(length>prefix.length)prefix=this.text.slice(0,length)
    }
    // The planner sees the current tail, but knows that it can still change.
    if(prefix.length<8 && prefix!==this.text)return null
    if(prefix.length<4)return null
    // A stable clause can stay useful while the host starts the next clause.
    const clause=prefix.match(/^[\s\S]*[，,。.!！？?；;：:]/u)?.[0]
    const text=clause?.length>=4?clause:prefix
    if(this.sameContent(text,this.reviewed))return null
    return {text,stableText:prefix,heardText:this.text,confirmed:this.confirmed===text}
  }
  review(text) {this.reviewed=text;this.nextAt=this.now()+this.intervalMs}
  sameContent(left,right) {
    return this.normalize(left)===this.normalize(right)
  }
  normalize(text) {return text.replace(/[\s，。!！？?；;、：:]/gu,'').replace(/(?<!\d)[,.]|[,.](?!\d)/gu,'')}
  matches(text) {return this.sameContent(this.text,text)}
  relevant(text,heard=this.text) {
    if(this.sameContent(heard,text))return true
    const prefix=this.normalize(text),current=this.normalize(heard)
    if(!current.startsWith(prefix))return false
    // ASR can append punctuation after a stable clause. The new boundary validates that same prefix, not an unfinished word.
    const boundary=/[，,。.!！？?；;：:]$/u.test(text) || [...heard.matchAll(/[，,。.!！？?；;：:]/gu)].some(match=>{
      if(/[,.]/.test(match[0]) && /\d/.test(heard[match.index-1]??'') && /\d/.test(heard[match.index+1]??''))return false
      return this.sameContent(heard.slice(0,match.index),text)
    })
    if(!boundary)return false
    const tail=current.slice(prefix.length)
    // Ordinary elaboration can keep a joke relevant. Corrections and floor claims cannot.
    return tail.length<=48 && !/(?:但是|不过|其实|说错|更正|(?<!是)不是|并不|并没|等等|等一下|先听|别说|没说完|先讲完)/u.test(tail)
  }
}
