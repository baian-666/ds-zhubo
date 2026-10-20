import { randomUUID } from 'node:crypto'
import * as v from 'valibot'

const revision=v.pipe(v.string(),v.uuid()),at=v.pipe(v.number(),v.safeInteger(),v.minValue(0))
export const inferenceSchema=v.strictObject({provider:v.literal('deepseek'),model:v.pipe(v.string(),v.regex(/^[\w./:-]{1,128}$/))})
export const recognitionSchema=v.variant('provider',[
  v.strictObject({provider:v.literal('siliconflow'),model:v.literal('FunAudioLLM/SenseVoiceSmall')}),
  v.strictObject({provider:v.literal('dashscope'),model:v.literal('fun-asr-realtime')}),
  v.strictObject({provider:v.literal('local'),model:v.literal('sherpa-zipformer-zh')}),
])
const record=schema=>v.strictObject({schemaVersion:v.literal(1),revision,updatedAt:at,value:schema})
export const moduleSchemas={inference:record(inferenceSchema),recognition:record(recognitionSchema)}
function fail(status,message){throw Object.assign(new Error(message),{status})}

/** Each service has its own revision. Changing recognition cannot invalidate a playing voice. */
export class ModuleSettings {
  constructor({store,model='deepseek-flash'}={}) {
    this.store=store;this.values=new Map()
    for(const [name,value] of Object.entries({inference:{provider:'deepseek',model},recognition:{provider:'siliconflow',model:'FunAudioLLM/SenseVoiceSmall'}})) {
      const saved=store?.loadModule(name)
      const entry=saved??{schemaVersion:1,revision:randomUUID(),updatedAt:Date.now(),value}
      if(!v.safeParse(moduleSchemas[name],entry).success)throw Error('Saved service configuration is invalid')
      if(!saved)store?.saveModule(name,entry,null)
      this.values.set(name,entry)
    }
  }
  snapshot(name){return structuredClone(this.values.get(name))}
  save(name,value,revision) {
    const previous=this.values.get(name)
    if(!previous)fail(400,'未知服务配置')
    if(previous.revision!==revision)fail(409,'配置已在其他窗口更新，请重新载入后保存')
    const entry={schemaVersion:1,revision:randomUUID(),updatedAt:Date.now(),value}
    const parsed=v.safeParse(moduleSchemas[name],entry)
    if(!parsed.success)fail(400,'服务配置无效')
    try{this.store?.saveModule(name,parsed.output,revision)}
    catch(error){fail(error.code==='SETTINGS_CONFLICT'?409:503,'配置未保存，继续使用原配置。请重新载入或检查本机存储。')}
    this.values.set(name,parsed.output);return this.snapshot(name)
  }
  status(){return {storage:this.store?'sqlite':'memory'}}
}

/** Validate model access without generating a response or adding a request to live turns. */
export async function verifyInference(value,{key,fetchImpl=fetch,signal}={}) {
  if(!v.safeParse(inferenceSchema,value).success)fail(400,'回复模型配置无效')
  if(!key)fail(503,'请先在本机 .env 配置 DEEPSEEK_API_KEY 并重启服务')
  let response
  try {response=await fetchImpl('https://api.deepseek.com/models',{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])})}
  catch {fail(502,'无法验证回复模型，请检查网络；原配置已保留')}
  if(!response.ok){await response.body?.cancel();fail(502,'无法验证回复模型，请检查密钥或权限；原配置已保留')}
  const result=await response.json()
  if(!Array.isArray(result.data)||!result.data.some(item=>item.id===value.model))fail(400,'该模型未在当前账号的模型列表中，原配置已保留')
}
