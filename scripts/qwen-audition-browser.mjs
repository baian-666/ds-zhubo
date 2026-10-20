const $ = id => document.getElementById(id)
const token = document.querySelector('meta[name="csrf"]').content
const headers = { 'Content-Type': 'application/json', 'X-Setup-Token': token }
let audio, controller, generation = 0, sources = [], replayUrl, firstPacket, firstScheduled, gapCount, complete, timing
const seconds = ms => (ms / 1000).toFixed(2) + ' 秒'

function stop() {
  generation++
  controller?.abort()
  controller = null
  for (const source of sources) { try { source.stop() } catch {} }
  sources = []
  $('replay').pause()
  $('stop').disabled = true
  $('play').disabled = false
}
$('stop').onclick = () => { stop(); $('result').textContent = '已停止，待播放音频已清空。' }

async function prepare() {
  $('play').disabled = true
  $('voice').disabled = true
  $('account').textContent = '正在提前连接百炼，不生成语音…'
  try {
    const response = await fetch('/prepare', { method: 'POST', headers, body: JSON.stringify({ voice: $('voice').value }) })
    const result = await response.json()
    $('account').textContent = result.message
  } catch { $('account').textContent = '提前连接未完成，试听时会重新连接。' }
  finally { $('play').disabled = false; $('voice').disabled = false }
}
$('voice').onchange = () => { stop(); prepare() }

async function status() {
  const result = await (await fetch('/status')).json()
  $('account').textContent = result.configured ? '百炼密钥已在本机配置。' : '请先配置百炼北京地域 API Key。'
  $('credentials').open = !result.configured
  $('play').disabled = !result.configured
  if (result.configured) await prepare()
}
$('setup').onsubmit = async event => {
  event.preventDefault()
  $('save').disabled = true
  let key = $('key').value.trim()
  $('key').value = ''
  $('account').textContent = '正在检查连接…'
  try {
    const request = fetch('/save', { method: 'POST', headers, body: JSON.stringify({ key }) })
    key = ''
    const response = await request, result = await response.json()
    $('account').textContent = result.message
    if (response.ok) { $('credentials').open = false; await prepare() }
  } catch { $('account').textContent = '连接失败，请检查本机试听服务。' }
  finally { key = ''; $('save').disabled = false }
}

function wav(chunks) {
  const size = chunks.reduce((n, chunk) => n + chunk.length, 0)
  const header = new ArrayBuffer(44), view = new DataView(header)
  const word = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)) }
  word(0, 'RIFF'); view.setUint32(4, 36 + size, true); word(8, 'WAVE'); word(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true)
  view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, size, true)
  return new Blob([header, ...chunks], { type: 'audio/wav' })
}

$('play').onclick = async () => {
  stop()
  const mine = generation
  const text = $('text').value.trim(), voice = $('voice').value, streaming = $('mode').value === 'stream'
  if (!text) { $('result').textContent = '请填写台词。'; return }
  $('play').disabled = true; $('stop').disabled = false; $('replay').hidden = true
  if (replayUrl) { URL.revokeObjectURL(replayUrl); replayUrl = null }
  const chunks = []
  controller = new AbortController()
  firstPacket = null; firstScheduled = null; gapCount = 0; complete = false; timing = null
  const start = performance.now()
  let next = 0, receivedDone = false
  const render = () => {
    const lines = [complete ? '音频已收齐，可听当前播放或下方重播。' : '正在接收音频…']
    if (firstPacket !== null) lines.push('点击到首音频：' + seconds(firstPacket))
    if (firstScheduled !== null) lines.push('点击到首次播放排程：' + seconds(firstScheduled))
    if (timing) lines.push('本次连接：' + (timing.reusedConnection ? '已复用' : '新建'), '建连与会话准备：' + seconds(timing.prepareMs), '服务提交文本到首音频：' + seconds(timing.synthesisFirstPcmMs), '服务收齐音频：' + seconds(timing.totalMs))
    lines.push('播放队列断档：' + gapCount + ' 次')
    $('result').textContent = lines.join('\n')
  }
  const schedule = bytes => {
    const buffer = audio.createBuffer(1, bytes.length / 2, 24000), samples = buffer.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
    const source = audio.createBufferSource()
    source.buffer = buffer; source.connect(audio.destination)
    if (next && next < audio.currentTime) gapCount++
    const when = Math.max(audio.currentTime + 0.04, next)
    if (firstScheduled === null) firstScheduled = performance.now() - start + (when - audio.currentTime) * 1000
    source.start(when); next = when + buffer.duration; sources.push(source)
    source.onended = () => { sources = sources.filter(item => item !== source); if (complete && !sources.length && mine === generation) $('stop').disabled = true }
  }
  try {
    audio ??= new AudioContext()
    await audio.resume()
    if (mine !== generation) return
    $('result').textContent = '正在连接百炼…'
    const response = await fetch('/trial', { method: 'POST', headers, body: JSON.stringify({ text, voice }), signal: controller.signal })
    if (!response.ok) throw new Error((await response.json()).message)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let pending = ''
    while (true) {
      const { done, value } = await reader.read()
      if (mine !== generation) { await reader.cancel(); return }
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const event = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1)
        if (event.type === 'error') throw new Error(event.message)
        if (event.type === 'audio') {
          firstPacket ??= performance.now() - start
          const bytes = Uint8Array.from(atob(event.pcm), char => char.charCodeAt(0))
          chunks.push(bytes)
          if (streaming) schedule(bytes)
          render()
        } else if (event.type === 'done') { receivedDone = true; timing = event }
      }
    }
    if (!receivedDone || !chunks.length) throw new Error('音频未完整返回，请重试。')
    if (!streaming) for (const chunk of chunks) schedule(chunk)
    complete = true
    replayUrl = URL.createObjectURL(wav(chunks)); $('replay').src = replayUrl; $('replay').hidden = false
    render()
  } catch (error) {
    if (mine === generation) { stop(); $('result').textContent = error.name === 'AbortError' ? '试听已停止。' : error.message }
  } finally {
    if (mine === generation) { $('play').disabled = false; if (!sources.length) $('stop').disabled = true }
  }
}
status().catch(() => { $('account').textContent = '无法连接本机服务，请刷新。' })
