import { randomUUID,createHash } from 'node:crypto'
import * as v from 'valibot'

const text=max=>v.pipe(v.string(),v.maxLength(max)),id=v.pipe(text(100),v.minLength(1))
// JSON extensions round-trip without interpretation. Service credentials never belong in a card.
function safeCard(value,depth=0) {
  if(depth>24)return false
  if(value===null||['string','boolean'].includes(typeof value))return true
  if(typeof value==='number')return Number.isFinite(value)
  if(Array.isArray(value))return value.length<=2000&&value.every(item=>safeCard(item,depth+1))
  return typeof value==='object'&&Object.entries(value).every(([key,item])=>!/^(__proto__|prototype|constructor|api[_-]?key|access[_-]?token|secret|password)$/i.test(key)&&safeCard(item,depth+1))
}
const cardSchema=v.pipe(v.looseObject({name:v.pipe(text(100),v.minLength(1)),version:text(100),systemPrompt:v.optional(text(12000)),description:v.optional(text(12000)),personality:v.optional(text(12000)),scenario:v.optional(text(12000)),extensions:v.optional(v.record(v.string(),v.unknown()))}),v.check(safeCard))
export const catalogValueSchema=v.pipe(v.strictObject({activeId:id,bound:v.boolean(),cards:v.pipe(v.array(v.strictObject({id,data:cardSchema})),v.minLength(1),v.maxLength(64))}),v.check(value=>new Set(value.cards.map(card=>card.id)).size===value.cards.length&&value.cards.some(card=>card.id===value.activeId)&&value.cards.some(card=>card.id==='default')))
export const catalogSchema=v.strictObject({schemaVersion:v.literal(1),revision:v.pipe(v.string(),v.uuid()),updatedAt:v.pipe(v.number(),v.safeInteger(),v.minValue(0)),value:catalogValueSchema})
export function cardPrompt(card) {
  return [card.systemPrompt,card.description,card.personality,card.scenario,card.extensions?.airi?.modules?.artistry?.widgetInstruction].filter(part=>typeof part==='string'&&part.trim()).join('\n\n')
}

/** The database owns the catalog. AIRI keeps a local editable copy and commits against its loaded revision. */
export class CharacterCatalog {
  constructor(store) {
    this.store=store;const saved=store?.loadModule('characters')
    if(saved&&!v.safeParse(catalogSchema,saved).success)throw Error('Saved character catalog is invalid')
    this.value=saved??null
  }
  snapshot(){return structuredClone(this.value)}
  save(value,revision) {
    if((this.value?.revision??null)!==revision)throw Object.assign(Error('角色卡已在其他窗口更新，请重新载入后保存'),{status:409})
    const next={schemaVersion:1,revision:randomUUID(),updatedAt:Date.now(),value}
    const parsed=v.safeParse(catalogSchema,next)
    if(!parsed.success||Buffer.byteLength(JSON.stringify(next))>1_000_000||value.cards.some(({data})=>cardPrompt(data).length>12000)||
      (value.bound&&!cardPrompt(value.cards.find(card=>card.id===value.activeId).data).trim()))throw Object.assign(Error('角色卡格式无效、人设为空、过大或含服务凭据字段'),{status:400})
    try {this.store?.saveModule('characters',parsed.output,revision)}
    catch(error){throw Object.assign(Error('角色卡未保存，请重新载入或检查本机存储'),{status:error.code==='SETTINGS_CONFLICT'?409:503})}
    this.value=parsed.output;return this.snapshot()
  }
  current() {
    if(!this.value)return undefined
    if(!this.value.value.bound)return {card:null,revision:this.value.revision}
    const entry=this.value.value.cards.find(card=>card.id===this.value.value.activeId)
    return {card:{id:entry.id,name:entry.data.name,prompt:cardPrompt(entry.data)},revision:this.value.revision}
  }
  status(){return {revision:this.value?.revision??null,storage:this.store?'sqlite':'memory',fingerprint:this.value?createHash('sha256').update(JSON.stringify(this.value.value)).digest('hex'):null}}
}
