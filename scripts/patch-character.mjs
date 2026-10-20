import { readFileSync, writeFileSync } from 'node:fs'
const root=new URL('../vendor/airi/',import.meta.url)
function patch(file, anchor, replacement) {
 const path=new URL(file,root), text=readFileSync(path,'utf8').replaceAll('\r\n','\n')
 if(replacement.includes('const transientDefaults') && text.includes('const transientDefaults'))return
 if(anchor==='    // State (read-only externally, but reactive)' && text.includes('    markTransient,\n'))return
 if(text.replace(/\s+/g,'').includes(replacement.replace(/\s+/g,'')))return
 if(!text.includes(anchor))throw Error('Character integration anchor changed: '+file)
 writeFileSync(path,text.replace(anchor,replacement))
}
const store='packages/stage-ui-live2d/src/stores/expression-store.ts'
patch(store, "  // ---- internal helpers", `  // Store the baseline separately from transient AI writes when saving defaults.
  const transientDefaults = new Map<string, { previous: number, written: number }>()
  function markTransient(id: string, previous: number, written: number) {
    transientDefaults.set(id, { previous, written })
  }
  function clearTransient(id: string) {
    transientDefaults.delete(id)
  }
  function persistLlmPolicy() {
    if (modelId.value)
      localStorage.setItem('expression-policy:' + modelId.value, JSON.stringify({ mode: llmMode.value, names: [...llmExposed.value] }))
  }
  function restoreLlmPolicy(id: string) {
    llmMode.value = 'none'
    llmExposed.value = new Map()
    try {
      const data = JSON.parse(localStorage.getItem('expression-policy:' + id) || 'null')
      if (data && ['none', 'all', 'custom'].includes(data.mode) && Array.isArray(data.names)) {
        llmMode.value = data.mode
        llmExposed.value = new Map(data.names.filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean'))
      }
    }
    catch { /* Invalid local preferences keep the restrictive default. */ }
  }

  // ---- internal helpers`)
patch(store,'    modelId.value = id','    modelId.value = id\n    transientDefaults.clear()\n    restoreLlmPolicy(id)')
patch(store,'    llmMode.value = mode','    llmMode.value = mode\n    persistLlmPolicy()')
patch(store,'    llmExposed.value.set(name, value)','    llmExposed.value.set(name, value)\n    persistLlmPolicy()')
patch(store,'      entry.defaultValue = entry.currentValue\n      defaults[name] = entry.currentValue',`      const transient = transientDefaults.get(name)
      const value = transient && entry.currentValue === transient.written ? transient.previous : entry.currentValue
      entry.defaultValue = value
      defaults[name] = value`)
patch(store,'    // State (read-only externally, but reactive)', '    markTransient,\n    clearTransient,\n    // State (read-only externally, but reactive)')
patch(store,'    modelId.value = \'\'','    modelId.value = \'\'\n    transientDefaults.clear()')
for (const lang of ['en','zh-Hans']) {
 const old=lang==='en'?'LLM tool integration is not yet wired up.':'LLM 工具集成尚未接入。'
 const next=lang==='en'?'Live cohost obeys this policy while its stage is open. All also allows whale component controls; Custom allows selected named expressions only. Native chat tools remain separate.':'直播助播遵守此权限并按模型保存。全部同时允许鲸鱼组件控制；自定义仅允许选中的命名表情。普通头身姿态不受此表情开关控制。AIRI 原生聊天工具仍独立。'
 patch('packages/i18n/src/locales/'+lang+'/settings.yaml','llm-integration-wip: '+old,'llm-integration-wip: '+next)
}
writeFileSync(new URL('packages/stage-ui-live2d/src/stores/expression-policy.test.ts',root),readFileSync(new URL('../integrations/airi/expression-policy.test.ts',import.meta.url)))
console.log('Applied character expression policy and transient defaults protection.')
