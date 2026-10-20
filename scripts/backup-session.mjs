import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionStore } from '../apps/cohost/session-store.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const directory=join(root,'data/session-backups')
mkdirSync(directory,{recursive:true})
const target=join(directory,new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8)+'.sqlite')
await SessionStore.backupFile(join(root,'data/cohost-session.sqlite'),target)
console.log('Session backup saved: '+target)
