import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('../',import.meta.url))

/** Keep child pnpm commands on the pinned version and the same dependency layout. */
export function airiEnvironment(extra={}) {
  const env={...process.env,...extra}
  // pnpm 11 changes this default in CI. A different value can purge node_modules.
  env.pnpm_config_enable_global_virtual_store='false'
  env.pnpm_config_verify_deps_before_run='error'
  const paths=[dirname(process.execPath)]
  if(process.platform==='win32') {
    const bin=join(root,'data/toolchains/bin')
    const shim=join(bin,'pnpm.cmd')
    const contents='@echo off\r\n"%~dp0..\\node-v26.7.0-win-x64\\node.exe" "%~dp0..\\pnpm-11.24.0\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n'
    if(existsSync(shim)&&readFileSync(shim,'utf8').replaceAll('\r\n','\n')!==contents.replaceAll('\r\n','\n'))throw Error('The local pnpm launcher has unsaved edits')
    mkdirSync(bin,{recursive:true});writeFileSync(shim,contents)
    paths.unshift(bin)
  }
  const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path')
  if(pathKey){paths.push(env[pathKey]);delete env[pathKey]}
  env.PATH=paths.join(delimiter)
  return env
}
