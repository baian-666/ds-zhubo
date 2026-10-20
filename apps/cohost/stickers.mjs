import { StageSources } from './stage-sources.mjs'
// Only metadata crosses the bridge. AIRI retains image bytes and resolves asset IDs.
export class StickerCatalog {
  constructor({ random = Math.random, ...options } = {}) {
    this.random=random; this.sources=new StageSources(options)
  }
  update(body) {
    if (!body || !['desktop','web'].includes(body.stage) || typeof body.enabled!=='boolean' ||
      !Number.isFinite(body.frequency) || body.frequency<0 || body.frequency>100 ||
      !Array.isArray(body.entries) || body.entries.length>48 ||
      body.entries.some(x=>!x || typeof x.id!=='string' || !/^[\w-]{1,100}$/.test(x.id) ||
        typeof x.description!=='string' || x.description.length>60) ||
      new Set(body.entries.map(x=>x.id)).size!==body.entries.length) {
      const error=new Error('表情包目录无效');error.status=400;throw error
    }
    this.sources.set(structuredClone(body))
  }
  current() {
    return this.sources.current()
  }
  select() {
    const source=this.current()
    return source?.enabled && this.random()*100<source.frequency ? source.entries : []
  }
  resolve(id, offered) {
    const source=this.current()
    if (!source?.enabled || typeof id!=='string' || !offered.some(x=>x.id===id))return undefined
    const entry=source.entries.find(x=>x.id===id)
    return entry ? {id:entry.id,description:entry.description} : undefined
  }
}
