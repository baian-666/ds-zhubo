import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { BlivechatRelay } from '../apps/cohost/blivechat.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
export function saveBilibiliConfig(envPath, { kind, value }) {
  if (!['code', 'room'].includes(kind) || typeof value !== 'string') throw Error('Invalid setting')
  value = value.trim()
  const config = {
    url: 'ws://127.0.0.1:12451/api/chat',
    code: kind === 'code' ? value : '',
    roomId: kind === 'room' ? value : '',
  }
  if (!new BlivechatRelay({ config }).status().configured) throw Error('Invalid setting')
  const previous = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const values = {
    BILIBILI_SOURCE: 'blivechat',
    BILIBILI_RELAY_URL: config.url,
    BILIBILI_ANCHOR_CODE: config.code,
    BILIBILI_RELAY_ROOM_ID: config.roomId,
  }
  const lines = previous
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*(?:export\s+)?(?:BILIBILI_SOURCE|BILIBILI_RELAY_URL|BILIBILI_ANCHOR_CODE|BILIBILI_RELAY_ROOM_ID)\s*=/.test(
          line,
        ),
    )
  while (lines.at(-1) === '') lines.pop()
  // Quote the identity code so #, $ and other printable characters are literal environment values.
  if (config.code.includes('"') || config.code.includes("'")) throw Error('Invalid setting')
  for (const [key, v] of Object.entries(values))
    lines.push(`${key}=${key === 'BILIBILI_ANCHOR_CODE' ? '"' + v + '"' : v}`)
  lines.push('')
  const staging = join(dirname(envPath), 'data', 'credential-staging')
  mkdirSync(staging, { recursive: true })
  const temporary = join(staging, randomUUID())
  try {
    writeFileSync(temporary, lines.join(previous.includes('\r\n') ? '\r\n' : '\n'), {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, envPath)
  } finally {
    rmSync(temporary, { force: true })
  }
}
export function createBilibiliSetup({
  envPath = join(root, '.env'),
  fetchImpl = fetch,
  onSaved = () => {},
} = {}) {
  const nonce = randomBytes(24).toString('base64url')
  const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小鲸鱼 · B站弹幕配置</title>
<style>body{margin:0;padding:24px;background:#edf3f5;color:#183044;font:17px/1.7 system-ui}main{max-width:580px;margin:6vh auto;background:white;border-radius:18px;padding:28px}input,select,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;margin:8px 0;border:1px solid #b6ccd6;border-radius:9px}button{background:#b5e7e6;cursor:pointer}small{color:#597482}a{color:#187c8c}</style>
<main data-bilibili-setup><h1>接入 B站真实弹幕</h1><p>已采用本机 blivechat。无需自建开发者应用，不开启推流、不自动收音。</p>
<p><a href="https://play-live.bilibili.com/" target="_blank" rel="noopener noreferrer">打开 B站身份码入口</a> · <a href="http://127.0.0.1:12451/" target="_blank" rel="noopener noreferrer">打开本机 blivechat</a></p>
<p>在 B站页面右上角点“身份码”，按提示登录主播账号。若内置浏览器无法打开，请在平常使用的 Edge 或 Chrome 打开 <a href="https://play-live.bilibili.com/" target="_blank" rel="noopener noreferrer">互动玩法首页</a>。取得后回到此页填写；不要发到聊天里。</p>
<form id="setup"><label for="kind">连接方式</label><select id="kind"><option value="code">主播身份码（推荐）</option><option value="room">房间号（兼容试验）</option></select>
<label for="value" id="label">主播身份码</label><input id="value" type="password" autocomplete="off" spellcheck="false" maxlength="256" required><button id="save">保存并应用</button></form>
<p id="state" role="status">身份码只写入本机忽略的 .env，不显示、不提交。无需提供 Cookie。</p><small>保存后，在小鲸鱼“当前配置”里点击“连接 B站弹幕”。已连接只是本机转发通道正常，要看到真实观众消息才算接通。房间号模式可能遇到信息打码或收取限制。</small></main>
<script nonce="${nonce}">const form=document.getElementById('setup'),kind=document.getElementById('kind'),input=document.getElementById('value'),button=document.getElementById('save'),state=document.getElementById('state');
kind.onchange=()=>{input.value='';input.type=kind.value==='code'?'password':'text';document.getElementById('label').textContent=kind.value==='code'?'主播身份码':'房间号';};
form.onsubmit=async e=>{e.preventDefault();button.disabled=true;let value=input.value.trim();input.value='';state.textContent='正在保存本机配置…';try{const r=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${nonce}'},body:JSON.stringify({kind:kind.value,value})});value='';const result=await r.json();state.textContent=result.message;if(r.ok)form.hidden=true;}catch{state.textContent='本机配置未完成，请刷新后重试。';}finally{value='';button.disabled=false;}};</script></html>`
  let saving = false
  const server = createServer(async (req, res) => {
    const reply = (status, message) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify({ message }))
    }
    const host = '127.0.0.1:' + server.address().port
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== host)
      return reply(403, '只接受本机配置。')
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      })
      res.end(page)
      return
    }
    if (req.method !== 'POST' || req.url !== '/save') return reply(404, '未找到。')
    const actual = Buffer.from(String(req.headers['x-setup-token'] || '')),
      expected = Buffer.from(nonce)
    if (
      req.headers.origin !== 'http://' + host ||
      req.headers['sec-fetch-site'] === 'cross-site' ||
      req.headers['content-type'] !== 'application/json' ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return reply(403, '请从本机配置页操作。')
    if (saving) return reply(409, '正在保存。')
    saving = true
    try {
      const chunks = []
      let size = 0
      for await (const c of req) {
        size += c.length
        if (size > 2048) return reply(413, '请求过大。')
        chunks.push(c)
      }
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        saveBilibiliConfig(envPath, body)
      } catch {
        return reply(400, '身份码或房间号格式不正确，现有配置未更改。')
      }
      // Update only the chat source. Do not restart voice, clear the room, or connect automatically.
      let applied = false
      try {
        const env = parseEnv(readFileSync(envPath, 'utf8'))
        const r = await fetchImpl('http://127.0.0.1:8787/api/bilibili/reload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(env.COHOST_ACCESS_TOKEN ? { Authorization: 'Bearer ' + env.COHOST_ACCESS_TOKEN } : {}),
          },
          body: '{}',
          signal: AbortSignal.timeout(5000),
        })
        applied = r.ok
        await r.body?.cancel()
      } catch {}
      reply(
        200,
        applied
          ? '配置已保存并生效。回到小鲸鱼，点击“连接 B站弹幕”，再让观众发一句话测试。'
          : '配置已保存。助播后台更新或启动后生效，然后点击“连接 B站弹幕”。',
      )
      onSaved()
    } catch {
      if (!res.headersSent) reply(500, '本机配置未完成。')
    } finally {
      saving = false
    }
  })
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createBilibiliSetup()
  server.listen(8791, '127.0.0.1', () => console.log('B站弹幕本机配置：http://127.0.0.1:8791/'))
  const expiry = setTimeout(
    () => {
      server.close()
      server.closeAllConnections()
    },
    60 * 60 * 1000,
  )
  server.on('close', () => clearTimeout(expiry))
  server.on('error', () => {
    clearTimeout(expiry)
    console.error('弹幕配置页无法启动，请检查 8791 端口。')
    process.exitCode = 1
  })
}
