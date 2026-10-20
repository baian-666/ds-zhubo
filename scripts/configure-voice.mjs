import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { keyValid as qwenKeyValid } from './qwen-credential.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const same = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

// Only this ignored local setting is changed. Existing credentials are never returned.
export function saveVoiceKey(envPath, key, name = 'SILICONFLOW_API_KEY') {
  if (!['SILICONFLOW_API_KEY', 'DASHSCOPE_API_KEY'].includes(name)) throw new Error('不支持的凭据名称。')
  if (name === 'DASHSCOPE_API_KEY' ? !qwenKeyValid(key) : typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(key))
    throw new Error('密钥格式不正确，请只粘贴 API 密钥。')
  const previous = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const lines = previous.split(/\r?\n/)
  const assignment = new RegExp('^\\s*(?:export\\s+)?' + name + '\\s*=')
  let inserted = false
  const updated = lines.filter(line => {
    if (!assignment.test(line)) return true
    if (inserted) return false
    inserted = true
    return true
  }).map(line => assignment.test(line) ? name + '=' + key : line)
  if (!inserted) {
    if (updated.at(-1) === '') updated.pop()
    updated.push(name + '=' + key, '')
  }
  const staging = join(dirname(envPath), 'data', 'credential-staging')
  mkdirSync(staging, {recursive:true})
  const temporary = join(staging, randomUUID())
  try {
    writeFileSync(temporary, updated.join(previous.includes('\r\n') ? '\r\n' : '\n'), {mode:0o600, flag:'wx'})
    renameSync(temporary, envPath)
  } finally { rmSync(temporary, {force:true}) }
}

export function createVoiceSetup({envPath = join(root, '.env'), fetchImpl = fetch, onSaved = () => {}} = {}) {
  const nonce = randomBytes(24).toString('base64url')
  let saving = false
  const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>配置语音服务</title><style>body{background:#0c141d;color:#e9f2f5;font:17px/1.7 system-ui;margin:0;padding:24px}main{max-width:560px;margin:8vh auto;background:#172430;padding:28px;border-radius:18px}input,button{font:inherit;box-sizing:border-box;width:100%;padding:12px;border-radius:9px;margin:10px 0}input{background:#0c141d;color:#fff;border:1px solid #466272}button{background:#80d8c4;border:0;cursor:pointer}small{color:#abbfce}#state{min-height:3em}</style>
<main><h1>配置小鲸鱼的语音服务</h1><p>在这里粘贴硅基流动 API 密钥。输入会隐藏，密钥只保存到本机忽略的 .env。</p>
<form id="setup"><label for="key">API 密钥</label><input id="key" type="password" autocomplete="off" spellcheck="false" minlength="16" maxlength="512" required>
<button id="save">保存并检查连接</button></form><p id="state" role="status">会检查账号连接，不生成语音、不扣语音合成费用。</p>
<small>现有 DeepSeek 配置会保留。这个步骤只配置账号，AIRI 原生语音桥接还需要继续接入。</small></main>
<script nonce="${nonce}">const form=document.getElementById('setup'),key=document.getElementById('key'),button=document.getElementById('save'),state=document.getElementById('state');
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;state.textContent='正在检查连接…';let value=key.value.trim();key.value='';
try{const response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${nonce}'},body:JSON.stringify({key:value})});value='';const result=await response.json();state.textContent=result.message;if(response.ok){form.hidden=true;state.textContent+=' 可以回到聊天告诉我“配置好了”。';}}
catch{state.textContent='连接失败，请刷新本页后重试。'}finally{value='';button.disabled=false;}});</script></html>`
  const server = createServer(async (request,response) => {
    const reply = (status,message) => {
      response.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})
      response.end(JSON.stringify({message}))
    }
    const address = server.address()
    const host = '127.0.0.1:' + address.port
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== host) return reply(403,'只接受本机配置。')
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
      response.end(page);return
    }
    if (request.method !== 'POST' || request.url !== '/save') return reply(404,'未找到。')
    if (request.headers.origin !== 'http://' + host || request.headers['sec-fetch-site'] === 'cross-site' ||
        !same(String(request.headers['x-setup-token'] ?? ''),nonce) || request.headers['content-type'] !== 'application/json')
      return reply(403,'请从本机配置页操作。')
    if (saving) return reply(409,'正在保存，请稍等。')
    saving = true
    try {
      let size = 0
      const chunks = []
      for await (const chunk of request) {
        size += chunk.length
        if (size > 2048) return reply(413,'请求过大。')
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(400,'请求格式错误。') }
      const key = body?.key
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(key)) return reply(400,'密钥格式不正确，请只粘贴 API 密钥。')
      // Account validation only. Never echo provider bodies or errors containing credentials.
      let result
      try { result = await fetchImpl('https://api.siliconflow.cn/v1/models',{headers:{Authorization:'Bearer ' + key},signal:AbortSignal.timeout(15000)}) }
      catch { return reply(502,'暂时无法连接硅基流动。密钥未保存，请稍后重试。') }
      if (!result.ok) {
        await result.body?.cancel()
        return reply(400,result.status === 401 || result.status === 403 ? '密钥未通过验证，请检查复制是否完整、账号是否可用。' : '服务暂时不可用，密钥未保存，请稍后重试。')
      }
      await result.body?.cancel()
      try { saveVoiceKey(envPath,key) } catch { return reply(500,'本机配置写入失败，现有配置不会在页面显示。') }
      reply(200,'语音服务账号连接成功，密钥已保存到本机 .env。')
      onSaved()
    } catch { if(!response.headersSent) reply(500,'配置未完成，请重试。') }
    finally { saving = false }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let expiry
  const server = createVoiceSetup({onSaved:() => {
    clearTimeout(expiry)
    setTimeout(()=>{server.close();server.closeIdleConnections()},2000).unref()
  }})
  server.listen(8789,'127.0.0.1',()=>console.log('语音配置页 http://127.0.0.1:8789/ — 15 分钟有效，保存后关闭。'))
  expiry = setTimeout(()=>{server.close();server.closeAllConnections()},15*60*1000)
  server.on('error',()=>{console.error('配置页无法启动，请检查 8789 端口。');process.exitCode=1;clearTimeout(expiry)})
}
