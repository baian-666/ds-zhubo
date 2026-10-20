import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as v from 'valibot'
import { capabilitiesSchema, constrainPerformance, emptyCapabilities, performanceTarget, sameTarget } from '../../packages/cohost-contracts/performance.ts'
import { StageSources } from './stage-sources.mjs'

export const defaultPersona = readFileSync(new URL('./personas/xiaojingyu.md', import.meta.url), 'utf8')
export class RuntimeProfile {
  constructor(options = {}) { this.sources = new StageSources(options);this.catalog=options.catalog }
  update(body) {
    const fail = () => { const error = new Error('角色与表演配置无效'); error.status = 400; throw error }
    const capabilities=v.safeParse(capabilitiesSchema,body?.capabilities)
    if (!body || !['desktop','web'].includes(body.stage) || !capabilities.success) fail()
    if (body.card !== null && (!body.card || typeof body.card.id !== 'string' || body.card.id.length > 100 ||
      typeof body.card.name !== 'string' || !body.card.name.trim() || body.card.name.length > 100 ||
      typeof body.card.prompt !== 'string' || !body.card.prompt.trim() || body.card.prompt.length > 12000)) fail()
    const value = {stage:body.stage, owner:body.owner, capabilities:capabilities.output, card:body.card && {...body.card}}
    value.revision = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16)
    this.sources.set(value)
    this.last = this.current() ?? this.last
    return value.revision
  }
  current() {
    return this.sources.current()
  }
  snapshot() {
    const live = this.current()
    const owner = this.sources.owner()
    const value = live || ((!owner || this.last?.owner === owner) ? this.last : undefined)
    const saved=this.catalog?.current(),card=saved?saved.card:value?.card
    return {name:card?.name || '小鲸鱼', prompt:card?.prompt || defaultPersona,
      cardFingerprint:card ? createHash('sha256').update(card.prompt).digest('hex') : '', cardId:card?.id || '', stage:value?.stage || '', owner:value?.owner || '', revision:(saved?.revision??'')+(value?.revision || ''),
      expressions:live?.capabilities.expressions || [], components:!!live?.capabilities.components.length, modelId:value?.capabilities.modelId || '',
      capabilities:live?.capabilities || emptyCapabilities(value?.capabilities.modelId)}
  }
  filter(result, offered) {
    const policy = this.snapshot()
    const target=performanceTarget(policy.capabilities)
    const previous=offered ?? result.performanceTarget
    const filtered=previous && !sameTarget(previous,target)
      ? {performance:'idle',motion:undefined,issues:['stale-capabilities']}
      : constrainPerformance(result,policy.capabilities)
    return {...result,performance:filtered.performance,motion:filtered.motion,performanceTarget:target,performanceIssues:[...new Set([...(result.performanceIssues??[]),...filtered.issues])].slice(0,32)}
  }
}
