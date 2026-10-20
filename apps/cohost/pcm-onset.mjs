/** Remove only leading near-silence; keep 40 ms before the first quiet consonant. */
export class PcmOnset {
  constructor() {this.leading=Buffer.alloc(0);this.started=false}
  accept(event) {
    if(event.type!=='audio' || this.started)return event
    const pcm=Buffer.concat([this.leading,Buffer.from(event.pcm,'base64')])
    const padding=Math.ceil(event.sampleRate*0.04)*2
    let first=0
    while(first<pcm.length && Math.abs(pcm.readInt16LE(first))<32)first+=2
    if(first===pcm.length){this.leading=pcm.subarray(Math.max(0,pcm.length-padding));return null}
    this.leading=Buffer.alloc(0);this.started=true
    return {...event,pcm:pcm.subarray(Math.max(0,first-padding)).toString('base64')}
  }
}
