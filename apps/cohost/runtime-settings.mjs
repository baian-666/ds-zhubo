import { randomUUID } from 'node:crypto'
import * as v from 'valibot'
import { speechProviders } from '../../packages/cohost-contracts/speech.ts'

const speechSchema=v.pipe(v.strictObject({
  engine:v.picklist(['index','aqua','qwen','siliconflow']),voice:v.string(),
}),v.check(value=>speechProviders.find(provider=>provider.id===value.engine)?.voices.includes(value.voice)))
export const runtimeSettingsSchema=v.strictObject({
  schemaVersion:v.literal(1),revision:v.pipe(v.string(),v.uuid()),updatedAt:v.pipe(v.number(),v.safeInteger(),v.minValue(0)),
  speech:speechSchema,
})
function fail(status,message) {throw Object.assign(new Error(message),{status})}

/** Provider defaults come from the same registry as the native AIRI settings page. */
export function speechSettings(engine,voice) {
  const provider=speechProviders.find(item=>item.id===engine)
  const result=v.safeParse(speechSchema,{engine,voice:voice||provider?.voices[0]})
  if(!result.success)fail(400,'无效声音配置')
  return result.output
}

/** Ordinary settings share the session database, but have a separate revision and lifetime.
 * Seed environment values once. Stored settings take precedence on every later start.
 * Credentials, runtime leases and chat resets never enter this repository.
 */
export class RuntimeSettings {
  constructor({store,seed,now=Date.now}={}) {
    this.store=store;this.now=now
    let saved
    try {saved=store?.loadSettings()} catch {throw new Error('Saved runtime settings could not be read; restore a valid database backup')}
    if(saved) {
      const result=v.safeParse(runtimeSettingsSchema,saved)
      if(!result.success)throw new Error('Saved runtime settings are invalid; restore a valid database backup')
      this.value=result.output
    } else {
      this.value={schemaVersion:1,revision:randomUUID(),updatedAt:now(),speech:speechSettings(seed.engine,seed.voice)}
      store?.saveSettings(this.value,null)
    }
  }
  snapshot() {return structuredClone(this.value)}
  status() {return {storage:this.store?'sqlite':'memory',savedAt:this.store?this.value.updatedAt:null}}
  saveSpeech(settings,revision) {
    if(revision!==this.value.revision)fail(409,'声音配置已在其他窗口更新，请刷新后重试')
    const next={schemaVersion:1,revision:randomUUID(),updatedAt:this.now(),speech:v.safeParse(speechSchema,settings)}
    if(!next.speech.success)fail(400,'无效声音配置')
    next.speech=next.speech.output
    try {this.store?.saveSettings(next,revision)}
    catch(error) {
      if(error.code==='SETTINGS_CONFLICT')fail(409,'本机配置已被其他进程修改，请重启直播服务后重试')
      fail(503,'声音设置未保存，已保留原配置，请检查本机存储')
    }
    this.value=next
    return this.snapshot()
  }
}
