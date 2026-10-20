import { DatabaseSync, backup } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as v from 'valibot'
import { continuitySchema } from './session-continuity.mjs'
import { runtimeSettingsSchema } from './runtime-settings.mjs'
import { moduleSchemas } from './module-settings.mjs'
import { catalogSchema } from './character-catalog.mjs'
import { handbookSchema } from './director-handbook.mjs'

const number = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
const text = max => v.pipe(v.string(), v.maxLength(max))
const optional = schema => v.optional(schema)
const engine = v.picklist(['deepseek', 'mock'])
const input = v.object({
  source:v.picklist(['host','viewer','program','followup']), text:text(2000), engine:optional(engine),
  platform:optional(text(32)), userId:optional(text(128)), displayName:optional(text(128)),
  id:optional(text(128)), real:optional(v.boolean()), participation:optional(text(32)),
})
const entry = v.object({
  id:number, revision:optional(number), role:v.picklist(['host','viewer','assistant','director']), text:text(20000), at:number,
  utterance:optional(v.nullable(number)), turn:optional(number), status:optional(text(32)), engine:optional(v.picklist(['deepseek','mock','preview'])), model:optional(text(128)),
  characterId:optional(text(128)), deliveryId:optional(text(128)), delivery:optional(text(32)), playedChars:optional(number),
  source:optional(text(32)), replyingTo:optional(text(2000)), input:optional(text(32)), restored:optional(v.boolean()),
  userId:optional(text(128)), displayName:optional(text(128)), platform:optional(text(32)), messageId:optional(text(128)), real:optional(v.boolean()),
  action:optional(text(32)), reason:optional(text(128)), explanation:optional(text(2000)), directorRevision:optional(number), traceId:optional(number),
  error:optional(text(2000)), errorCode:optional(text(128)), performance:optional(text(128)), motionLabel:optional(text(128)),
  performanceWarnings:optional(v.array(text(128))), sticker:optional(v.object({id:text(128),description:text(500)})),
  firstMs:optional(v.nullable(number)), firstAudioMs:optional(number), decisionMs:optional(number), asrMs:optional(number),
  speechRevision:optional(text(128)), timings:optional(v.record(text(64),number)), interruptionReason:optional(text(64)),
  inferenceRevision:optional(text(128)),profileRevision:optional(text(128)),
})
const observation = v.object({
  id:number, at:number, topic:number, role:v.picklist(['host','viewer','assistant']), text:text(20000),
  engine:optional(engine), characterId:optional(text(128)), deliveryId:optional(text(128)), delivery:optional(text(32)),
  deliveryState:optional(v.picklist(['partial','complete','interrupted'])),
  utterance:optional(v.nullable(number)), userId:optional(text(128)), displayName:optional(text(128)),
  platform:optional(text(32)), messageId:optional(text(128)), real:optional(v.boolean()),
})
const memory = v.object({
  id:text(128), characterId:text(128), engine, input, text:text(20000), at:number, topic:number,
  delivery:v.picklist(['audio','text']), complete:v.boolean(), interrupted:v.boolean(),
})
const checkpointFields = {
  room:v.object({session:text(128),version:number,entries:v.pipe(v.array(entry),v.maxLength(300))}),
  scene:v.object({topic:number,version:number,entries:v.pipe(v.array(observation),v.maxLength(60))}),
  memories:v.pipe(v.array(memory),v.maxLength(96)),
}
// Version 1 is read for the one-time upgrade. New checkpoints use version 2.
const schema = v.variant('format',[
  v.object({format:v.literal(1),...checkpointFields}),
  v.object({format:v.literal(2),...checkpointFields,continuity:continuitySchema}),
])

async function copyDatabase(db,path) {
  if(existsSync(path))throw new Error('Backup destination already exists')
  await backup(db,path)
  const copy=new DatabaseSync(path)
  try {copy.exec('DELETE FROM runtime_owner; PRAGMA wal_checkpoint(TRUNCATE)')} finally {copy.close()}
}

/** One bounded local checkpoint. A transaction binds displayed and delivered records together.
 * SQLite never receives model credentials, active leases, queued actions, or raw audio.
 * A process lease prevents a second backend from taking over the database.
 * The revision also rejects writes after an external checkpoint change.
 */
export class SessionStore {
  constructor(path) {
    mkdirSync(dirname(path),{recursive:true})
    this.db = new DatabaseSync(path)
    this.owner=randomUUID()
    this.ownsDatabase=false
    try {
      this.db.exec('PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;')
      const version = this.db.prepare('PRAGMA user_version').get().user_version
      if (![0,1,2,3].includes(version)) throw new Error('Unsupported session database version')
      this.db.exec('CREATE TABLE IF NOT EXISTS current_session (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, saved_at INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runtime_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const owner=this.db.prepare('SELECT pid FROM runtime_owner WHERE id=1').get()
        if(owner) {
          let alive=true
          try {process.kill(owner.pid,0)} catch(error) {if(error.code==='ESRCH')alive=false}
          if(alive)throw new Error('Session database is already open in another runtime')
        }
        this.db.prepare('INSERT OR REPLACE INTO runtime_owner VALUES (1,?,?)').run(process.pid,this.owner)
        // Migrate only after taking the process lease. A second backend cannot mutate a live database.
        this.db.exec('CREATE TABLE IF NOT EXISTS runtime_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS module_settings (id TEXT PRIMARY KEY, revision TEXT NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=3;')
        this.db.exec('COMMIT')
        this.ownsDatabase=true
      } catch(error) {this.db.exec('ROLLBACK');throw error}
      const row = this.db.prepare('SELECT * FROM current_session WHERE id=1').get()
      this.revision = row?.revision ?? 0
      this.savedAt = row?.saved_at ?? null
      this.restored = row ? v.parse(schema, JSON.parse(row.payload)) : null
    } catch (error) { this.close(); throw error }
  }
  loadSettings() {
    const row=this.db.prepare('SELECT revision,payload FROM runtime_settings WHERE id=1').get()
    if(!row)return null
    const settings=JSON.parse(row.payload)
    if(settings?.revision!==row.revision)throw new Error('Runtime settings revision is inconsistent')
    return settings
  }
  loadModule(name) {
    const row=this.db.prepare('SELECT revision,payload FROM module_settings WHERE id=?').get(name)
    if(!row)return null
    const value=JSON.parse(row.payload)
    if(value.revision!==row.revision)throw Error('Module revision is inconsistent')
    return value
  }
  saveModule(name,value,expectedRevision) {
    const schema=name==='characters'?catalogSchema:name==='director-handbook'?handbookSchema:moduleSchemas[name]
    if(!schema)throw Error('Unknown settings module')
    const payload=JSON.stringify(v.parse(schema,value))
    if(Buffer.byteLength(payload)>(['characters','director-handbook'].includes(name)?1_000_000:4096))throw Error('Settings exceeded limit')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row=this.db.prepare('SELECT revision FROM module_settings WHERE id=?').get(name)
      const owner=this.db.prepare('SELECT token FROM runtime_owner WHERE id=1').get()
      if(owner?.token!==this.owner||(row?.revision??null)!==expectedRevision)throw Object.assign(Error('Settings changed in another process'),{code:'SETTINGS_CONFLICT'})
      this.db.prepare('INSERT INTO module_settings VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(name,value.revision,payload)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  saveSettings(settings,expectedRevision) {
    const payload=JSON.stringify(v.parse(runtimeSettingsSchema,settings))
    if(Buffer.byteLength(payload)>4096)throw new Error('Runtime settings exceeded limit')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row=this.db.prepare('SELECT revision FROM runtime_settings WHERE id=1').get()
      const owner=this.db.prepare('SELECT token FROM runtime_owner WHERE id=1').get()
      if(owner?.token!==this.owner || (row?.revision??null)!==expectedRevision)
        throw Object.assign(new Error('Runtime settings changed in another process'),{code:'SETTINGS_CONFLICT'})
      this.db.prepare('INSERT INTO runtime_settings VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(settings.revision,payload)
      this.db.exec('COMMIT')
    } catch(error) {this.db.exec('ROLLBACK');throw error}
  }
  save(snapshot) {
    const payload = JSON.stringify(v.parse(schema,snapshot))
    if (Buffer.byteLength(payload)>2_000_000) throw new Error('Session checkpoint exceeded limit')
    const at = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT revision FROM current_session WHERE id=1').get()
      const owner=this.db.prepare('SELECT token FROM runtime_owner WHERE id=1').get()
      if (owner?.token!==this.owner || (row?.revision ?? 0) !== this.revision) throw new Error('Session checkpoint changed in another process')
      this.db.prepare('INSERT INTO current_session VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,saved_at=excluded.saved_at,payload=excluded.payload').run(this.revision+1,at,payload)
      this.db.exec('COMMIT')
      this.revision++; this.savedAt=at
    } catch(error) { this.db.exec('ROLLBACK'); throw error }
  }
  async backupTo(path) { await copyDatabase(this.db,path) }
  static async backupFile(source,target) {
    const db=new DatabaseSync(source,{readOnly:true})
    try {await copyDatabase(db,target)} finally {db.close()}
  }
  eraseRetiredPages() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
  close() {
    try {if(this.ownsDatabase)this.db.prepare('DELETE FROM runtime_owner WHERE token=?').run(this.owner)}
    finally {this.db.close()}
  }
}

export const characterKey = profile => profile.cardId ? `card:${profile.cardId}` : 'builtin:xiaojingyu'

/** Only confirmed delivery enters conversation history. Each role and engine has six turns.
 * Progress replaces the same delivery ID. A restart keeps its prefix, never its unsaid suffix.
 */
export class SessionMemory {
  constructor(records=[]) {
    this.records=structuredClone(records).map(record=>({...record,interrupted:!record.complete || record.interrupted}))
  }
  remember(turn,answer,topic) {
    if (!answer || turn.input.source==='preview') return
    const existing=this.records.find(record=>record.id===turn.deliveryId)
    const complete=turn.generationDone && answer.length===turn.answer.length
    const record={id:turn.deliveryId,characterId:turn.characterId,engine:turn.input.engine??'deepseek',
      input:v.parse(input,turn.input),text:answer,at:existing?.at??Date.now(),topic,
      delivery:turn.delivery,complete,interrupted:!complete && turn.controller.signal.aborted}
    this.records=this.records.filter(item=>item.id!==record.id)
    this.records.push(record)
    const matching=this.records.filter(item=>item.characterId===record.characterId && item.engine===record.engine)
    const expired=new Set(matching.slice(0,-6).map(item=>item.id))
    this.records=this.records.filter(item=>!expired.has(item.id)).slice(-96)
    return record
  }
  history(characterId,engine='deepseek') {
    return this.records.filter(record=>record.characterId===characterId && record.engine===engine).flatMap(record=>[
      {role:'user',content:JSON.stringify(record.input)},
      {role:'assistant',content:record.text},
    ])
  }
  clear() { this.records=[] }
}

/** Coalesce generated tokens. Input and playback receipts call flush before acknowledgment.
 * A disk error keeps the last durable checkpoint and exposes an error to the settings UI.
 */
export class SessionPersistence {
  constructor(store,capture) { this.store=store;this.capture=capture;this.recovered=Boolean(store?.restored);this.error=null;this.dirty=false;this.closed=false }
  schedule() {
    if(!this.store || this.closed)return
    this.dirty=true
    if(!this.timer) {this.timer=setTimeout(()=>this.flush(),200);this.timer.unref()}
  }
  flush() {
    clearTimeout(this.timer);this.timer=null
    if(!this.store || this.closed || !this.dirty)return !this.error
    try {this.store.save(this.capture());this.error=null;this.dirty=false;return true}
    catch {this.error='session_save_failed';return false}
  }
  close() {this.flush();this.closed=true;this.store?.close()}
  status() {return {enabled:Boolean(this.store),recovered:this.recovered,savedAt:this.store?.savedAt??null,error:this.error}}
}
