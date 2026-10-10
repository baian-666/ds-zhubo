import { connectStage } from './stage-bridge.mjs'
const $ = id => document.getElementById(id)
const poseNames={idle:'待机',listen:'倾听',think:'思考',nod:'点头',smile:'轻笑',surprise:'惊讶',pout:'嘴硬'}
let stageSeen=0
const stageBridge=connectStage($('stage'), status=>{
  stageSeen=Date.now()
  $('performanceState').textContent=status.ready ? '角色已连接 · '+poseNames[status.name]+' · 本机姿态表演' : '表演桥接已连接 · 等待 Live2D 模型加载'
})
for(const button of document.querySelectorAll('[data-pose]'))button.onclick=()=>safe(()=>api('performance',{name:button.dataset.pose}))

const stageUrl='http://127.0.0.1:5173/?cohostOrigin='+encodeURIComponent(location.origin)
$('stage').src=stageUrl
const savedEngine = sessionStorage.getItem('rehearsalEngine')
if (['deepseek','mock'].includes(savedEngine)) $('engine').value = savedEngine
let state, utterance, activeRequest = null, activeTurn = null, refreshing = false, submitting = false
let seenTrace = 0, attemptedDecision = 0, simulatedNumber = 0, blockedDecision = 0
const reasons = {
  participation_reaction:'我先用文字或表情回应，不抢话',
  participation_changed: '自主参与设置改变，旧决定作废', scene_changed: '现场有新消息，重新判断',
  mode_changed: '导演模式改变，旧机会作废', host_voice_detected: '听到主播活动，先观察，不直接打断',
  transcript_updated: '主播文本更新，旧判断作废', short_acknowledgment: '短附和，保留助播话轮',
  exact_stop_phrase: '主播明确要求停止', explicit_address: '点名交棒，开始接话',
  needs_semantic_evidence: '观察这句话的参与机会', decision_consumed: '交棒决定已消费',
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
  const sequence = ++requestSequence
  const response = await fetch(`/api/${path}`, {method:body === undefined ? 'GET':'POST',headers:headers(),body:body === undefined ? undefined:JSON.stringify(body),signal})
  if (!response.ok) { const error = new Error((await response.json()).error); error.status = response.status; throw error }
  response.taskSequence = sequence
  return response
}
async function event(body) {
  const result = await data(await api('director/event',body))
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
    state = await data(await api('status'))
    $('rehearsalState').textContent=state.muted ? '小鲸鱼已暂停回应' : $('engine').value==='mock' ? '模拟回复 · 不调用模型' : !state.deepseekConfigured ? 'DeepSeek 未配置 · 请先配置本机密钥' : state.director.mode==='auto' ? '真实 DeepSeek · 小鲸鱼自动决定何时参与' : '人工接话 · 在更多设置里让小鲸鱼回答'
    $('initiative').checked = Boolean(state.participation?.enabled)
    $('initiative').disabled = !state.participation?.configured || $('engine').value === 'mock'
    $('initiativeState').textContent = state.participation?.busy ? '正在判断参与时机…' : state.participation?.enabled ? '自然接话；明确交棒直接回复。决定会显示在聊天里。' : '当前仅使用明确交棒规则。'
    $('status').textContent = `${state.deepseekConfigured ? 'DeepSeek 已配置 · 连通性待调用确认' : 'DeepSeek 未配置 · 可用模拟回复'} · ${state.model} · 队列 ${state.queued} · ${state.muted ? '静音' : state.hostSpeaking ? '倾听主播' : state.busy ? '助播回答中' : '等待参与机会'}`
    $('mode').value = state.director.mode; $('muted').checked = state.muted; $('speaking').checked = state.hostSpeaking
    $('viewerWindow').checked = state.director.viewerWindow
    renderQueue(state.queue)
    for (const item of state.director.trace) if (item.id > seenTrace) {
      trace(actions[item.action] ?? item.action, item.explanation ?? reasons[item.reason] ?? item.reason, item.at); seenTrace = item.id
    }
    if (activeTurn !== null && state.turn > activeTurn) activeRequest?.abort()
    autoReply()
  } finally { refreshing = false }
}

function autoReply() {
  const candidate = state?.director?.candidate
  if (submitting || activeRequest || state?.director?.mode !== 'auto' || !candidate || candidate.id <= attemptedDecision) return
  if ($('engine').value === 'deepseek' && !state.deepseekConfigured) {
    if (blockedDecision !== candidate.id) {
      blockedDecision = candidate.id
      feedback('导演已允许接话，但本机未配置 DeepSeek 密钥。请把“回复”切换为“模拟回复”，或直接点“先看模拟效果”。')
      trace('等待', 'DeepSeek 未配置，未调用模型')
    }
    return
  }
  attemptedDecision = candidate.id
  void generate('director', candidate.id)
}
async function generate(source, decision) {
  if (activeRequest) { feedback('已有回答，先打断或等待完成'); return }
  const controller = new AbortController(); activeRequest = controller; activeTurn = null
  const started = performance.now(), engine = $('engine').value
  $('answer').textContent = ''; feedback('正在接话…'); $('latency').textContent = '首字：等待'
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
        if (!controller.signal.aborted && item.entry && item.session === roomSession) renderMessage(item.entry)
        if (item.type === 'delta') {
          if (controller.signal.aborted) break
          if (first) { const ms=Math.round(performance.now()-started); $('latency').textContent=item.entry?.decisionMs !== undefined ? `判断与拟稿：${item.entry.decisionMs} ms` : `生成首字：${item.entry?.firstMs ?? ms} ms`; trace('首字',`${ms} ms · ${engine}`); first=false }
          $('answer').textContent += item.text
        }
        if (['done','cancelled','error'].includes(item.type)) {
          ended=true
          feedback(item.type === 'done' ? '文字回答完成' : item.type === 'cancelled' ? '已打断，未完成回复不进入上下文' : item.message)
          trace(item.type === 'done' ? '完成' : item.type === 'cancelled' ? '打断' : '失败', $('result').textContent)
        }
      }
      if (done) break
    }
    if (!ended) throw new Error('连接中断，回答未完成')
  } catch(error) {
    feedback(error.name==='AbortError' ? '已打断，旧回答已废弃' : error.message)
    trace(error.name==='AbortError' ? '打断' : '失败', $('result').textContent)
  } finally {
    if (activeRequest === controller) { activeRequest=null; activeTurn=null }
    $('manualReply').disabled=$('viewerReply').disabled=false
    void refresh().catch(() => {})
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
    if (state.director.mode === 'manual') feedback('主播文字已提交。人工导演不会自动回复，请点右侧“人工让助播接话”。')
    else if (!state.director.candidate) feedback(state.director.intent === 'backchannel' ? '这句是短附和，保留助播当前回答。' : state.director.intent === 'stop' ? '主播要求停止，当前回答已打断。' : state.participation?.enabled ? '助播正在观察这句话，稍后会在聊天里说明等待或接话的原因。' : '当前使用规则导演，这句没有明确交棒。可开启“自主参与”测试自然接话。')
  } finally { submitting=false; autoReply() }
}
async function enqueue(text, simulated=false) {
  const result = await data(await api('danmaku',{id:crypto.randomUUID(),platform:$('platform').value,
    userId: simulated ? `sim-${++simulatedNumber}` : $('userId').value.trim() || `viewer-${++simulatedNumber}`,text,
    mentioned:simulated ? /^(助播|小鲸鱼)/u.test(text) : $('mentioned').checked,selected:false}))
  trace('弹幕', result.accepted ? text : '重复消息已忽略')
}
async function safe(action) { try { await action(); await refresh() } catch(error) { feedback(error.message); trace('提示',error.message) } }
function bind(id, action, name='click') { $(id).addEventListener(name,() => safe(action)) }

// All director and assistant messages share the same visible character.
let roomSession = null, roomVersion = -1, lastRoomSequence = 0
const messageNodes = new Map()
const decisionLabels = { needs_semantic_evidence:'观察', manual_reply:'人工接话', manual_interrupt:'打断', reset:'重置', mode_changed:'切换模式',
  manual_mute_changed:'调整静音', viewer_window_changed:'调整弹幕窗口', topic_changed:'切换话题', viewer_selected:'选择弹幕',
  decision_consumed:'接话', viewer_decision_consumed:'回复弹幕' }
const processReasons = new Set(['host_voice_detected','transcript_updated','decision_consumed','viewer_decision_consumed','manual_host_override'])
const directorWords = {
  mode_changed: '发言时机已切换。人工模式由你让我接话；自动模式由我观察交棒机会。',
  host_voice_detected: '我听到你开始讲话，先观察；普通附和不会直接打断我的回答。',
  transcript_updated: '我收到更新的主播文字，正在重新判断。',
  short_acknowledgment: '这句是短附和，我会继续当前回答。',
  exact_stop_phrase: '你明确让我停一下，我现在停止这轮回答。',
  explicit_address: '你点名把话交给我，而且已经说完了，我来接话。',
  needs_semantic_evidence: '我先等你说完。这句没有明确交棒证据，我暂时不接话。',
  decision_consumed: '这次交棒已处理，开始生成回复，不重复接话。',
  viewer_window_changed: '弹幕发言窗口已调整。我还会检查主播活动、冷却和消息是否过期。',
  viewer_window_open: '现在主播空闲，这条弹幕也符合条件，我来回复它。',
  viewer_decision_consumed: '这条弹幕已进入回复，不重复消费。',
  viewer_selected: '你点选了弹幕，我会优先考虑它。',
  topic_changed: '话题已切换，我清掉旧弹幕和旧接话机会。',
  manual_interrupt: '你按了打断，我停止这轮回答。',
  manual_mute_changed: '静音设置已改变，我会按新的设置决定能否发言。',
  manual_reply: '你让我接话，我按人工指令准备回答。',
  manual_wait: '现在是人工导演模式。我已听到这句，等你点“人工让助播接话”。',
  adapter: '我收到了你指定的模拟语义，并据此调整接话决定。',
  semantic: '异步语义判断已返回，我据此调整接话决定。',
  semantic_timeout: '语义判断超时，我继续等待。',
  semantic_unavailable: '语义判断暂不可用，我继续等待。',
  explicit_interrupt: '收到明确的打断指令，我停止这轮回答。',
  reset: '本场聊天和模型上下文已清空，我们重新开始。',
  viewer_manual_wait: '我看到弹幕了。现在是人工导演模式，等你点“人工挑一条回复”。',
  viewer_window_closed: '我看到弹幕了，但弹幕接话窗口还没打开。需要时勾选“自动导演允许回复弹幕”。',
  viewer_host_speaking: '我看到弹幕了，但主播还在讲话，我先等一个空闲机会。',
  viewer_busy: '我先把当前回答说完，之后再考虑这条弹幕。',
  viewer_ineligible: '这条弹幕暂时不能回复。我会检查静音、提问或点选状态、20 秒全局冷却和 60 秒同观众冷却。',

}
function pinnedToBottom() {
  const box = $('chatScroll')
  return box.scrollHeight - box.scrollTop - box.clientHeight < 70
}
function renderMessage(entry) {
  let node = messageNodes.get(entry.id)
  if (node && node.revision >= entry.revision) return
  const pinned = pinnedToBottom()
  if (!node) {
    const item = document.createElement('li')
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden','true')
    const body = document.createElement('div'); body.className = 'messageBody'
    const meta = document.createElement('div'); meta.className = 'messageMeta'
    const sender = document.createElement('strong'), badge = document.createElement('span'), time = document.createElement('time')
    badge.className = 'badge'; meta.append(sender,badge,time)
    const quote = document.createElement('div'); quote.className = 'replyContext'
    const bubble = document.createElement('div'); bubble.className = 'bubble'
    const status = document.createElement('div'); status.className = 'messageState'
    body.append(meta,quote,bubble,status); item.append(avatar,body)
    node = {item,avatar,sender,badge,time,quote,bubble,status,revision:-1}
    messageNodes.set(entry.id,node)
    const following = [...$('messages').children].find(x => Number(x.dataset.id) > entry.id)
    $('messages').insertBefore(item, following ?? null)
  }
  roomVersion = Math.max(roomVersion, entry.revision)
  node.revision = entry.revision
  node.item.className = 'message ' + entry.role + (processReasons.has(entry.reason) ? ' process' : '')
  node.item.dataset.id = entry.id
  node.avatar.textContent = ['assistant','director'].includes(entry.role) ? '鲸' : entry.role === 'host' ? '主' : '弹'
  node.sender.textContent = entry.role === 'viewer' ? (entry.userId || '观众') : entry.role === 'host' ? '主播' : '小鲸鱼'
  node.badge.textContent = entry.role === 'director' ? '导演决定 · ' + (decisionLabels[entry.reason] ?? actions[entry.action] ?? entry.action) :
    entry.role === 'assistant' ? (entry.delivery === 'reaction' ? '文字 / 表情回应 · 不开口' : '助播回复') : entry.role === 'viewer' ? '模拟弹幕' : '模拟发言'
  node.time.textContent = new Date(entry.at).toLocaleTimeString('zh-CN',{hour12:false})
  node.time.dateTime = new Date(entry.at).toISOString()
  node.quote.hidden = entry.role !== 'assistant' || !entry.replyingTo
  node.quote.textContent = entry.replyingTo ? '回复：' + entry.replyingTo : ''
  node.bubble.textContent = entry.role === 'director' ? (entry.explanation ?? directorWords[entry.reason] ?? reasons[entry.reason] ?? entry.reason) :
    entry.text || (entry.status === 'generating' ? '正在想怎么回答…' : entry.status === 'cancelled' ? '还没说出文字就被打断了。' : '没有收到回复文字。')
  const labels = {generating:'正在回复…',completed:'回答完成',cancelled:'已打断 · 保留可见片段',failed:'调用失败',awaitingPlayback:'等待播放反馈'}
  node.status.textContent = entry.role === 'assistant' ?
    [entry.performance ? '表演意图：'+poseNames[entry.performance] : '', entry.engine === 'mock' ? '模拟回复 · 无 API 调用' : entry.model, entry.decisionMs !== undefined ? '判断与拟稿 ' + entry.decisionMs + ' ms' : entry.firstMs === null ? '' : '生成首字 ' + entry.firstMs + ' ms', labels[entry.status], entry.error].filter(Boolean).join(' · ') : entry.decisionMs !== undefined ? '自主判断 ' + entry.decisionMs + ' ms' : ''
  node.status.hidden = !node.status.textContent
  $('chatEmpty').hidden = messageNodes.size > 0
  if (pinned) $('chatScroll').scrollTop = $('chatScroll').scrollHeight
}
function renderRoom(room, sequence = 0) {
  if (!room || (sequence && sequence < lastRoomSequence)) return
  if (sequence) lastRoomSequence = sequence
  if (room.session !== roomSession) {
    roomSession = room.session; roomVersion = -1
    messageNodes.clear(); $('messages').replaceChildren(); $('chatEmpty').hidden = false
  }
  if (room.version < roomVersion) return
  roomVersion = room.version
  const ids = new Set(room.entries.map(x => x.id))
  for (const [id,node] of messageNodes) if (!ids.has(id)) {node.item.remove(); messageNodes.delete(id)}
  for (const entry of room.entries) renderMessage(entry)
  const lastAnswer = room.entries.findLast(x => x.role === 'assistant')
  if (lastAnswer && !activeRequest) {
    $('answer').textContent = lastAnswer.text || (lastAnswer.status === 'generating' ? '正在接话…' : '本轮没有回复文字')
    if (lastAnswer.firstMs !== null) $('latency').textContent = lastAnswer.decisionMs !== undefined ? '判断与拟稿：' + lastAnswer.decisionMs + ' ms' : '生成首字：' + lastAnswer.firstMs + ' ms'
    $('replyLabel').textContent = lastAnswer.engine === 'mock' ? '模拟回复 · 无 API 调用' : 'DeepSeek · ' + lastAnswer.model
  }
}
let requestSequence = 0
async function data(response) {
  const result = await response.json()
  renderRoom(result.room, response.taskSequence)
  if(result.performance) stageBridge.update(result.performance,response.taskSequence)
  if(Date.now()-stageSeen>3500)$('performanceState').textContent='等待舞台表演连接，请确认 AIRI 已启动并加载模型'
  return result
}
function chooseSpeaker(role) {
  const host = role === 'host'
  $('hostComposer').hidden = !host; $('viewerComposer').hidden = host
  $('hostTab').setAttribute('aria-selected',String(host)); $('viewerTab').setAttribute('aria-selected',String(!host))
}
$('hostTab').addEventListener('click',() => chooseSpeaker('host'))
$('viewerTab').addEventListener('click',() => chooseSpeaker('viewer'))
$('showProcess').addEventListener('change',() => {
  const pinned = pinnedToBottom()
  $('chatScroll').classList.toggle('showProcess',$('showProcess').checked)
  if (pinned) $('chatScroll').scrollTop = $('chatScroll').scrollHeight
})
$('latest').addEventListener('click',() => { $('chatScroll').scrollTop = $('chatScroll').scrollHeight })
for (const [id,action] of [['hostText',speakLine],['viewerText',() => enqueue($('viewerText').value)]]) {
  $(id).addEventListener('keydown',event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void safe(action) }
  })
}

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
bind('preset',async () => { $('viewerText').value=$('preset').value },'change')
bind('presetSend',() => enqueue($('preset').value,true))
bind('speechStart',startSpeech); bind('finalText',finishText); bind('speechEnd',() => event({type:'speech-end',utterance}))
bind('semantic',() => event({type:'intent',revision:state?.director.revision,intent:$('intent').value,confidence:1}))
bind('initiative',() => api('participation',{enabled:$('initiative').checked}),'change')
bind('refresh',refresh)
bind('reset',async () => { await api('reset',{}); activeRequest?.abort(); $('answer').textContent='本场已清空'; utterance=null })
bind('reloadStage',() => { $('stageState').textContent='等待加载'; $('stage').src=stageUrl })
bind('engine',async () => { if(activeRequest || state?.busy) { $('engine').value=$('replyLabel').textContent.startsWith('模拟') ? 'mock' : 'deepseek'; throw new Error('请先完成或打断当前回答再切换回复来源') } sessionStorage.setItem('rehearsalEngine',$('engine').value); await api('participation',{enabled:$('engine').value==='deepseek' && Boolean(state?.participation?.configured)}); trace('回复来源',$('engine').selectedOptions[0].textContent) },'change')
const scenarios={natural:'你说我这跑步机是不是该改名叫晾衣机？',setup:'我的猫叫年糕，它每天霸占跑步机。先听我把故事讲完。',recall:'助播，你觉得刚才那只猫叫什么名字？',handover:'助播，你怎么看虚拟角色陪伴这件事？',pause:'说到这个问题，我先想一想，',backchannel:'嗯，对',stop:'等一下',opportunity:'今天这个故事真有意思，我刚刚突然想到了一个新角度。'}
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

function feedback(message) {
  $('result').textContent = message
  $('testFeedback').textContent = message
}


async function runQuickTrial(engine) {
  if (activeRequest || state?.busy) throw new Error('请先点“打断助播”，再试聊。')
  if (engine === 'deepseek' && !state?.deepseekConfigured)
    throw new Error('本机还没有 DeepSeek 密钥。请在本机 .env 填入 DEEPSEEK_API_KEY 并重启文字服务；密钥不要填在 AIRI 页面或聊天中。')
  $('engine').value = engine
  sessionStorage.setItem('rehearsalEngine',engine)
  await api('participation',{enabled:engine==='deepseek' && Boolean(state?.participation?.configured)})
  if (state.muted) await api('mute', { value: false })
  if (state.hostSpeaking) await api('host-speaking', { value: false })
  if (state.director.viewerWindow) await event({ type: 'viewer-window', value: false })
  if (state.director.mode !== 'auto') await event({ type: 'mode', value: 'auto' })
  chooseSpeaker('host')
  $('scenario').value = 'handover'
  $('hostText').value = scenarios.handover
  feedback(engine === 'deepseek' ? '正在向 DeepSeek 提交试聊，回复会显示在聊天气泡和字幕里，不会出声。' : '正在用模拟回复试跑，稍后会看到文字字幕，不会出声。')
  await speakLine()
}
bind('quickDemo', () => runQuickTrial('mock'))
bind('quickReal', () => runQuickTrial('deepseek'))
