import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const vendor = join(root, 'vendor/airi')
const web = spawnSync(process.execPath, [join(root, 'scripts/patch-airi.mjs')], {cwd:root,stdio:'inherit'})
if (web.status !== 0) throw new Error('Web overlay validation failed')
const appRoot = join(vendor, 'apps/stage-tamagotchi')
const savedRoot = join(root, 'data/airi-desktop-overlay')
function install(relative, contents) {
  const destination = join(appRoot, relative), saved = join(savedRoot, relative)
  if (existsSync(destination) && !readFileSync(destination).equals(contents) &&
      (!existsSync(saved) || !readFileSync(destination).equals(readFileSync(saved))))
    throw new Error('Desktop overlay has unsaved edits: ' + relative)
  mkdirSync(dirname(destination), {recursive:true}); mkdirSync(dirname(saved), {recursive:true})
  if (!existsSync(destination) || !readFileSync(destination).equals(contents)) writeFileSync(destination, contents)
  writeFileSync(saved, contents)
}
for (const name of ['cohost-contract.ts','use-cohost-performance.ts','cohost-desktop.ts'])
  install('src/renderer/cohost/' + name, readFileSync(join(root,'integrations/airi',name)))
for (const name of ['cohost-contract.ts','desktop-main.ts'])
  install('src/cohost/' + name, readFileSync(join(root,'integrations/airi',name)))
function hook(relative, anchor, replacement) {
  const destination = join(appRoot,relative)
  let text = readFileSync(destination,'utf8')
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
hook('src/main/windows/main/index.ts', "import icon from '../../../../resources/icon.png?asset'",
  "import { connectCohostDesktop } from '../../../cohost/desktop-main'\nimport icon from '../../../../resources/icon.png?asset'")
hook('src/main/windows/main/index.ts', '  await load(window, withHashRoute(',
  '  connectCohostDesktop(window)\n  await load(window, withHashRoute(')
hook('electron.vite.config.ts', 'developmentModels: sherpawModels,',
  "developmentModels: env.DS_ZHUBO_DESKTOP === '1' ? [] : sherpawModels,")
hook('src/main/windows/main/index.ts', 'if (is.dev || env.MAIN_APP_DEBUG || env.APP_DEBUG)',
  "if ((is.dev && env.DS_ZHUBO_DESKTOP !== '1') || env.MAIN_APP_DEBUG || env.APP_DEBUG)")
console.log('Applied the reproducible AIRI desktop cohost overlay.')
