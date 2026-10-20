import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { performanceContracts, performanceSource } from './performance-overlay.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const vendor = join(root, 'vendor/airi')
const web = spawnSync(process.execPath, [join(root, 'scripts/patch-airi.mjs')], {cwd:root,stdio:'inherit'})
if (web.status !== 0) throw new Error('Web overlay validation failed')
const appRoot = join(vendor, 'apps/stage-tamagotchi')
const savedRoot = join(root, 'data/airi-desktop-overlay')
// A release contains Electron's package.json, but it is not a pnpm workspace.
const workspacePath=join(vendor,'pnpm-workspace.yaml')
const workspaceText=readFileSync(workspacePath,'utf8')
const buildExclusion="  - '!apps/stage-tamagotchi/out/**'"
if(!workspaceText.includes(buildExclusion)) {
  const anchor="  - '!**/dist/**'"
  if(!workspaceText.includes(anchor))throw Error('AIRI workspace exclusion anchor changed')
  writeFileSync(workspacePath,workspaceText.replace(anchor,anchor+'\n'+buildExclusion))
}
function install(relative, contents) {
  const destination = join(appRoot, relative), saved = join(savedRoot, relative)
  if (existsSync(destination) && !readFileSync(destination).equals(contents) &&
      (!existsSync(saved) || !readFileSync(destination).equals(readFileSync(saved))))
    throw new Error('Desktop overlay has unsaved edits: ' + relative)
  mkdirSync(dirname(destination), {recursive:true}); mkdirSync(dirname(saved), {recursive:true})
  if (!existsSync(destination) || !readFileSync(destination).equals(contents)) writeFileSync(destination, contents)
  writeFileSync(saved, contents)
}
for (const name of [...performanceContracts,'whale-capabilities.ts','cohost-contract.ts','use-cohost-performance.ts','cohost-desktop.ts','motion-sequence.ts','motion-sequence.test.ts','whale-rig.ts','rig-controller.ts','pose-control.ts'])
  install('src/renderer/cohost/' + name, performanceSource(name))
for (const name of [...performanceContracts,'cohost-contract.ts','desktop-main.ts'])
  install('src/cohost/' + name, performanceSource(name))
function hook(relative, anchor, replacement) {
  const destination = join(appRoot,relative)
  let text = readFileSync(destination,'utf8').replaceAll('\r\n','\n')
  if (anchor.startsWith('import ') && text.includes(replacement.split('\n')[0])) return
  if (text.includes(replacement)) return
  if (!text.includes(anchor)) throw new Error('Desktop anchor changed: '+relative)
  writeFileSync(destination,text.replace(anchor,replacement))
}
// Remove only our earlier App hook. The page owns the model-ready signal.
const appPath = join(appRoot,'src/renderer/App.vue')
const originalAppText = readFileSync(appPath,'utf8')
let appText = originalAppText
appText = appText.replace("import { useCohostDesktopPerformance } from './cohost/cohost-desktop'\n",'')
  .replace("if (initialRoutePath === '/') useCohostDesktopPerformance()\n",'')
if(appText !== originalAppText) writeFileSync(appPath,appText)
hook('src/renderer/pages/index.vue', "import AuthStatusIsland from '../components/stage-islands/auth-status-island.vue'",
  "import { useCohostDesktopPerformance } from '../cohost/cohost-desktop'\nimport AuthStatusIsland from '../components/stage-islands/auth-status-island.vue'")
hook('src/renderer/pages/index.vue', "const componentStateStage = ref<'pending' | 'loading' | 'mounted'>('pending')",
  "const componentStateStage = ref<'pending' | 'loading' | 'mounted'>('pending')\nuseCohostDesktopPerformance(() => componentStateStage.value === 'mounted')")
const mainPath=join(appRoot,'src/main/windows/main/index.ts')
const beforeMain=readFileSync(mainPath,'utf8')
const mainImport="import { connectCohostDesktop } from '../../../cohost/desktop-main'"
const mainAnchor="import { electronStartDraggingWindow } from '../../../shared/eventa'"
if(!beforeMain.includes(mainAnchor))throw Error('Desktop main import anchor changed')
const afterMain=beforeMain.replace(mainImport+'\r\n','').replace(mainImport+'\n','').replace(mainAnchor,mainImport+'\n'+mainAnchor)
if(beforeMain!==afterMain)writeFileSync(mainPath,afterMain)
hook('src/main/windows/main/index.ts', '  await load(window, withHashRoute(',
  '  connectCohostDesktop(window)\n  await load(window, withHashRoute(')
hook('electron.vite.config.ts', 'developmentModels: sherpawModels,',
  "developmentModels: env.DS_ZHUBO_DESKTOP === '1' ? [] : sherpawModels,")
// Keep the existing localhost origin so the desktop model database and settings stay available.
const configPath=join(appRoot,'electron.vite.config.ts')
let configText=readFileSync(configPath,'utf8')
configText=configText.replace("{ host: '127.0.0.1', port: 5174, strictPort: true }", "{ host: 'localhost', port: 5174, strictPort: true }")
if(configText!==readFileSync(configPath,'utf8'))writeFileSync(configPath,configText)
hook('electron.vite.config.ts', '    server: {',
  "    server: {\n      ...(env.DS_ZHUBO_DESKTOP === '1' ? { host: 'localhost', port: 5174, strictPort: true } : {}),")
// Build into a new release directory. Running builds and development output stay untouched.
hook('electron.vite.config.ts', '  main: {\n    build: {',
  "  main: {\n    build: {\n      ...(env.DS_ZHUBO_BUILD_DIR ? { outDir: resolve(env.DS_ZHUBO_BUILD_DIR, 'main') } : {}),")
hook('electron.vite.config.ts', '  preload: {\n    build: {',
  "  preload: {\n    build: {\n      ...(env.DS_ZHUBO_BUILD_DIR ? { outDir: resolve(env.DS_ZHUBO_BUILD_DIR, 'preload') } : {}),")
hook('electron.vite.config.ts', '    build: {\n      rolldownOptions:',
  "    build: {\n      ...(env.DS_ZHUBO_BUILD_DIR ? { outDir: resolve(env.DS_ZHUBO_BUILD_DIR, 'renderer') } : {}),\n      rolldownOptions:")
hook('electron.vite.config.ts', "if (ctx.mode === 'production') {",
  "if (ctx.mode === 'production' && !env.DS_ZHUBO_BUILD_DIR) {")
hook('electron.vite.config.ts', "if (ctx.mode === 'development') {",
  "if (ctx.mode === 'development' || env.DS_ZHUBO_BUILD_DIR) {")
hook('src/main/windows/main/index.ts', 'if (is.dev || env.MAIN_APP_DEBUG || env.APP_DEBUG)',
  "if ((is.dev && env.DS_ZHUBO_DESKTOP !== '1') || env.MAIN_APP_DEBUG || env.APP_DEBUG)")
// Local builds update through the project launcher, not upstream installers or mock updates.
hook('src/main/index.ts', "enabled: import.meta.env.VITE_DISTRIBUTION !== 'steam',",
  "enabled: env.DS_ZHUBO_DESKTOP !== '1' && import.meta.env.VITE_DISTRIBUTION !== 'steam',")
console.log('Applied the reproducible AIRI desktop cohost overlay.')
