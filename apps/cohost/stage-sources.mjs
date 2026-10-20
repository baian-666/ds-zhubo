/** Selects metadata from the playback owner. Before a lease, prefer a fresh desktop. */
export class StageSources {
  constructor({now=Date.now,owner=()=>null}={}) {this.now=now;this.owner=owner;this.values=new Map()}
  set(value) {
    if(!['desktop','web'].includes(value.stage)||typeof value.owner!=='string'||!/^[\w:-]{8,100}$/.test(value.owner)) {
      const error=new Error('无效舞台配置来源');error.status=400;throw error
    }
    for(const [key,item] of this.values)if(this.now()-item.at>=30000)this.values.delete(key)
    if(!this.values.has(value.owner)&&this.values.size>=16) {const error=new Error('舞台配置来源过多');error.status=429;throw error}
    this.values.set(value.owner,{...value,at:this.now()})
  }
  current() {
    const owner=this.owner()
    if(owner) {const value=this.values.get(owner);return value&&this.now()-value.at<30000?value:undefined}
    for(const stage of ['desktop','web'])for(const value of this.values.values())
      if(value.stage===stage&&this.now()-value.at<30000)return value
  }
}
