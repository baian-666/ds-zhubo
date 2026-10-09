const $ = id => document.getElementById(id)
let state, utterance, activeRequest = null, activeTurn = null, refreshing = false, submitting = false
let seenTrace = 0, attemptedDecision = 0, simulatedNumber = 0
const reasons = {
  mode_changed: '导演模式改变，旧机会作废', host_voice_detected: '听到主播活动，先观察，不直接打断',
  transcript_updated: '主播文本更新，旧判断作废', short_acknowledgment: '短附和，保留助播话轮',
  exact_stop_phrase: '主播明确要求停止', explicit_address: '点名交棒，开始接话',
  needs_semantic_evidence: '没有明确交棒证据，继续听', decision_consumed: '交棒决定已消费',
  viewer_window_changed: '弹幕发言窗口改变', viewer_window_open: '主播空闲，窗口允许回复弹幕',
  viewer_decision_consumed: '弹幕决定已消费', viewer_selected: '主播点选弹幕',
  topic_changed: '话题切换，清除旧弹幕与机会', manual_interrupt: '人工打断',
  manual_mute_changed: '静音状态改变', manual_reply: '人工选择接话', adapter: '人工指定的模拟语义',
  semantic: '异步语义结果', semantic_timeout: '语义超时，继续等待', semantic_unavailable: '语义不可用，继续等待', reset: '本场上下文清空',
}
const actions = { hold: '等待', reply: '允许接话', stop: '打断' }
function trace(action, text, at = Date.now()) {
  const item = document.createElement('li')
  const time = document.createElement('time'); time.textContent = new Date(at).toLocaleTimeString('zh-CN',{hour12:false})
  const kind = document.createElement('strong'); kind.textContent = action
  const reason = document.createElement('span'); reason.textContent = text
  item.append(time, kind, reason); $('timeline').prepend(item)
  while ($('timeline').children.length > 120) $('timeline').lastChild.remove()
}
function headers() { return {'Content-Type':'application/json', ...($('token').value ? {Authorization:`Bearer ${$('token').value}`} : {})} }
async function api(path, body, signal) {
  const response = await fetch(`/api/${path}`, {method:body === undefined ? 'GET':'POST',headers:headers(),body:body === undefined ? undefined:JSON.stringify(body),signal})
  if (!response.ok) { const error = new Error((await response.json()).error); error.status = response.status; throw error }
  return response
}
async function event(body) {
  const result = await (await api('director/event',body)).json()
  state = { ...state, ...result }
  if (activeTurn !== null && result.turn > activeTurn) activeRequest?.abort()
  if (!submitting) autoReply()
  return result
}
function renderQueue(queue) {
  $('feed').replaceChildren()
  if (!queue.length) { $('feed').textContent = '暂无候选弹幕'; return }
  for (const message of queue) {
    const row = document.createElement('div'); row.className = 'comment'
    const meta = document.createElement('small'); meta.textContent = `${message.userId} · ${message.platform} · 剩余 ${Math.max(0, Math.ceil((message.expiresAt-Date.now())/1000))} 秒`
    const content = document.createElement('p'); content.textContent = message.text
    const select = document.createElement('button'); select.className = 'secondary'; select.textContent = message.selected ? '已点选' : '点选'
    select.disabled = message.selected
    select.onclick = () => safe(async () => { await api('danmaku/select',{id:message.id,platform:message.platform}); await refresh() })
    row.append(meta, content, select); $('feed').append(row)
  }
}
async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    state = await (await api('status')).json()
    $('status').textContent = `${state.deepseekConfigured ? 'DeepSeek 已配置 · 连通性待调用确认' : 'DeepSeek 未配置 · 可用模拟回复'} · ${state.model} · 队列 ${state.queued} · ${state.muted ? '静音' : state.hostSpeaking ? '倾听主播' : state.busy ? '助播回答中' : '等待参与机会'}`
    $('mode').value = state.director.mode; $('muted').checked = state.muted; $('speaking').checked = state.hostSpeaking
    $('viewerWindow').checked = state.director.viewerWindow
    renderQueue(state.queue)
    for (const item of state.director.trace) if (item.id > seenTrace) {
      trace(actions[item.action] ?? item.action, reasons[item.reason] ?? item.reason, item.at); seenTrace = item.id
    }
    if (activeTurn !== null && state.turn > activeTurn) activeRequest?.abort()
    autoReply()
  } finally { refreshing = false }
}
function autoReply() {
    const candidate = state?.director?.candidate
    if (!submitting && !activeRequest && state.director.mode === 'auto' && ($('engine').value === 'mock' || state.deepseekConfigured) && candidate && candidate.id > attemptedDecision) {
      attemptedDecision = candidate.id
      void generate('director', candidate.id)
    }
}
async function generate(source, decision) {
  if (activeRequest) { $('result').textContent = '已有回答，先打断或等待完成'; return }
  const controller = new AbortController(); activeRequest = controller; activeTurn = null
  const started = performance.now(), engine = $('engine').value
  $('answer').textContent = ''; $('result').textContent = '正在接话…'; $('latency').textContent = '首字：等待'
  $('replyLabel').textContent = engine === 'mock' ? '模拟回复 · 无 API 调用' : `DeepSeek · ${state?.model ?? ''}`
  $('manualReply').disabled = $('viewerReply').disabled = true
  trace('请求', `${source === 'director' ? '自动导演' : '人工导演'} · ${engine === 'mock' ? '模拟回复' : 'DeepSeek'}`)
  let first = true, ended = false
  try {
    const response = await api('reply',{source,engine,delivery:'text', ...(source === 'host' ? {text:$('hostText').value} : source === 'director' ? {decision} : {})},controller.signal)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const {value,done} = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value,{stream:true})
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const item = JSON.parse(buffer.slice(0,at)); buffer = buffer.slice(at+1)
        if (item.type === 'start') activeTurn = item.turn
        if (item.type === 'delta') {
          if (controller.signal.aborted) break
          if (first) { const ms=Math.round(performance.now()-started); $('latency').textContent=`首字：${ms} ms`; trace('首字',`${ms} ms · ${engine}`); first=false }
          $('answer').textContent += item.text
        }
        if (['done','cancelled','error'].includes(item.type)) {
          ended=true
          $('result').textContent = item.type === 'done' ? '文字回答完成' : item.type === 'cancelled' ? '已打断，未完成回复不进入上下文' : item.message
          trace(item.type === 'done' ? '完成' : item.type === 'cancelled' ? '打断' : '失败', $('result').textContent)
        }
      }
      if (done) break
    }
    if (!ended) throw new Error('连接中断，回答未完成')
  } catch(error) {
    $('result').textContent=error.name==='AbortError' ? '已打断，旧回答已废弃' : error.message
    trace(error.name==='AbortError' ? '打断' : '失败', $('result').textContent)
  } finally {
    if (activeRequest === controller) { activeRequest=null; activeTurn=null }
    $('manualReply').disabled=$('viewerReply').disabled=false
  }
}
async function startSpeech() {
  utterance = Math.max(Date.now(), (state?.director.utterance ?? 0)+1, (utterance ?? 0)+1)
  await event({type:'speech-start',utterance})
}
async function finishText() {
  if (!utterance) throw new Error('先开始讲话')
  return event({type:'transcript',utterance,text:$('hostText').value,final:true})
}
async function speakLine() {
  if (submitting) return
  if (!$('hostText').value.trim()) throw new Error('请先输入主播文字')
  submitting=true
  try {
    if (!state?.hostSpeaking || !utterance) await startSpeech()
    await finishText()
    await event({type:'speech-end',utterance})
    trace('主播', $('hostText').value)
  } finally { submitting=false; autoReply() }
}
async function enqueue(text, simulated=false) {
  const result = await (await api('danmaku',{id:crypto.randomUUID(),platform:$('platform').value,
    userId: simulated ? `sim-${++simulatedNumber}` : $('userId').value,text,
    mentioned:simulated ? text.startsWith('助播') : $('mentioned').checked,selected:false})).json()
  trace('弹幕', result.accepted ? text : '重复消息已忽略')
}
async function safe(action) { try { await action(); await refresh() } catch(error) { $('result').textContent=error.message; trace('提示',error.message) } }
function bind(id, action, name='click') { $(id).addEventListener(name,() => safe(action)) }
bind('hostSubmit', speakLine)
bind('manualReply', () => generate('host'))
bind('viewerReply', () => generate('viewer'))
bind('mode',async () => { await event({type:'mode',value:$('mode').value}); trace('模式', $('mode').value==='auto' ? '自动消费导演决定' : '人工选择接话时机') },'change')
bind('interrupt',async () => { await api('interrupt',{}); activeRequest?.abort() })
bind('muted',async () => { await api('mute',{value:$('muted').checked}); if ($('muted').checked) activeRequest?.abort() },'change')
bind('speaking',async () => { if($('speaking').checked) await startSpeech(); else if (utterance) await event({type:'speech-end',utterance}) },'change')
bind('viewerWindow', () => event({type:'viewer-window',value:$('viewerWindow').checked}),'change')
bind('topicChange',() => event({type:'topic-change'}))
bind('enqueue',() => enqueue($('viewerText').value))
bind('presetSend',() => enqueue($('preset').value,true))
bind('speechStart',startSpeech); bind('finalText',finishText); bind('speechEnd',() => event({type:'speech-end',utterance}))
bind('semantic',() => event({type:'intent',revision:state?.director.revision,intent:$('intent').value,confidence:1}))
bind('refresh',refresh)
bind('reset',async () => { await api('reset',{}); activeRequest?.abort(); $('answer').textContent='本场已清空'; utterance=null })
bind('reloadStage',() => { $('stageState').textContent='等待加载'; $('stage').src='http://127.0.0.1:5173' })
bind('engine',async () => { if(activeRequest || state?.busy) { $('engine').value=$('replyLabel').textContent.startsWith('模拟') ? 'mock' : 'deepseek'; throw new Error('请先完成或打断当前回答再切换回复来源') } trace('回复来源',$('engine').selectedOptions[0].textContent) },'change')
const scenarios={handover:'助播，你怎么看虚拟角色陪伴这件事？',pause:'说到这个问题，我先想一想，',backchannel:'嗯，对',stop:'等一下',opportunity:'今天这个故事真有意思，我刚刚突然想到了一个新角度。'}
bind('scenario',async () => { $('hostText').value=scenarios[$('scenario').value] },'change')
$('stage').addEventListener('load',() => { $('stageState').textContent='已加载 iframe · 形象待画面确认' })
setInterval(() => { if(!refreshing) void refresh().catch(error => { $('status').textContent=error.message }) },400)
setInterval(() => { if($('simulate').checked) { const options=[...$('preset').options]; void safe(() => enqueue(options[simulatedNumber%options.length].text,true)) } },5000)
void safe(refresh)

function expandStage(value) {
  $('stagePanel').classList.toggle('expanded', value)
  document.body.classList.toggle('stageExpanded', value)
  $('expandStage').setAttribute('aria-expanded', String(value))
  $('expandStage').textContent = value ? '收起舞台' : '放大舞台'
}
$('expandStage').addEventListener('click', () => expandStage(!$('stagePanel').classList.contains('expanded')))
document.addEventListener('keydown', event => { if (event.key === 'Escape') expandStage(false) })
