import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as v from 'valibot'
import { handbookSchema, coachingFields as fields } from '../../packages/cohost-contracts/director.ts'
export { handbookSchema } from '../../packages/cohost-contracts/director.ts'

export const directorManual = readFileSync(new URL('./director-manual.md',import.meta.url),'utf8')
const text = max => v.pipe(v.string(),v.minLength(1),v.maxLength(max))
const directive = v.variant('operation',[
  v.strictObject({operation:v.literal('remember'),quote:text(2000),...fields}),
  v.strictObject({operation:v.literal('revise'),id:text(128),quote:text(2000),...fields}),
  v.strictObject({operation:v.literal('forget'),id:text(128),quote:text(2000)}),
])
export function parseCoaching(value) {const parsed=v.safeParse(directive,value);return parsed.success?parsed.output:undefined}
export const coachingToolSchema = {type:'object',properties:{
  operation:{type:'string',enum:['remember','revise','forget']},id:{type:'string',maxLength:128},quote:{type:'string',maxLength:2000},
  situation:{type:'string',maxLength:100},guidance:{type:'string',maxLength:180},scope:{type:'string',enum:['context','general']},duration:{type:'string',enum:['persistent','session']},
},required:['operation','quote'],additionalProperties:false}
const failure=(status,message)=>Object.assign(new Error(message),{status})

// Independent of the room checkpoint: persistent coaching survives a new session.
// Mutations are compare-and-swap and publish only after the SQLite transaction succeeds.
export class DirectorHandbook {
  constructor({store,now=Date.now}={}) {
    this.store=store;this.now=now;this.error=null
    const saved=store?.loadModule('director-handbook')
    this.value=v.parse(handbookSchema,saved??{revision:randomUUID(),learningEnabled:true,notes:[]})
    this.savedRevision=saved?.revision??null
    if(this.value.notes.some(item=>item.duration==='session'))this.save({...this.value,notes:this.value.notes.filter(item=>item.duration==='persistent')})
  }
  save(value) {
    const next=v.parse(handbookSchema,{...value,revision:randomUUID()})
    try {this.store?.saveModule('director-handbook',next,this.savedRevision)}
    catch {this.error='导演手册保存失败，原有记录保留';throw failure(503,this.error)}
    this.value=next;this.savedRevision=this.store?next.revision:null;this.error=null
  }
  status(characterId) {
    return {...structuredClone(this.value),notes:structuredClone(this.value.notes.filter(item=>item.characterId===characterId)),characterId,persistent:Boolean(this.store),error:this.error}
  }
  context(characterId) {
    return {notes:this.value.notes.filter(item=>item.characterId===characterId).map(({id,situation,guidance,scope,duration,source})=>({id,situation,guidance,scope,duration,quote:source.quote.slice(0,240)}))}
  }
  capture({snapshot,characterId,session,evidence=[]}) {
    if(!this.value.learningEnabled || !snapshot.hostOpportunity || !snapshot.latestHost?.final || snapshot.listeningOpportunity || snapshot.floorOpportunity || snapshot.answerPreparation)return null
    const host=snapshot.latestHost
    return {revision:this.value.revision,characterId,session,host:{id:host.id,text:host.text},offered:this.context(characterId).notes.map(item=>item.id),
      source:{quote:host.text,at:this.now(),session,utterance:host.id??null,context:evidence.filter(item=>['host','assistant'].includes(item.role) && item.text && !(item.role==='host' && item.utterance===host.id)).slice(-3).map(item=>({role:item.role,text:item.text.slice(-240)}))}}
  }
  learn(value,captured,current) {
    const command=parseCoaching(value)
    if(!command || !captured || !this.value.learningEnabled || captured.revision!==this.value.revision ||
      current.characterId!==captured.characterId || current.session!==captured.session || !current.host?.final ||
      current.host.id!==captured.host.id || current.host.text!==captured.host.text || command.quote!==captured.host.text)return null
    if(command.operation!=='remember' && !captured.offered.includes(command.id))return null
    try {return this.mutate(command,captured.characterId,captured.source)} catch(error) {return {error:error.message}}
  }
  mutate(command,characterId,origin) {
    const notes=structuredClone(this.value.notes),index=notes.findIndex(item=>item.id===command.id && item.characterId===characterId)
    if(command.operation!=='remember' && index<0)throw failure(409,'这条反馈已经改变，请刷新手册')
    let item
    if(command.operation==='forget')notes.splice(index,1)
    else {
      const value=v.parse(v.object(fields),command)
      // Exact repeats do not consume storage or erase the original provenance.
      if(command.operation==='remember') {
        item=notes.find(note=>note.characterId===characterId && Object.keys(fields).every(key=>note[key]===value[key]))
        if(item)return {operation:'unchanged',note:structuredClone(item)}
        if(notes.length>=192 || notes.filter(note=>note.characterId===characterId).length>=24)throw failure(409,'当前手册已满，请合并或移除旧反馈')
      }
      item={id:index>=0?notes[index].id:randomUUID(),characterId,...value,source:origin,updatedAt:this.now()}
      if(index>=0)notes[index]=item;else notes.push(item)
    }
    this.save({...this.value,notes})
    return {operation:command.operation,note:item??{id:command.id}}
  }
  edit(body,{characterId,session}) {
    if(body.characterId!==characterId || body.revision!==this.value.revision)throw failure(409,'角色或手册已改变，请刷新后再保存；当前草稿可保留')
    if(body.operation==='learning') {
      if(typeof body.enabled!=='boolean')throw failure(400,'学习开关无效')
      this.save({...this.value,learningEnabled:body.enabled});return
    }
    const command=parseCoaching({...body.change,quote:body.change?.quote??'操作者在手册中编辑'})
    if(!command)throw failure(400,'手册条目无效')
    const original=this.value.notes.find(item=>item.id===command.id && item.characterId===characterId)
    return this.mutate(command,characterId,original?.source??{quote:command.quote,at:this.now(),session,utterance:null,context:[]})
  }
  clearSession() {this.save({...this.value,notes:this.value.notes.filter(item=>item.duration==='persistent')})}
}
