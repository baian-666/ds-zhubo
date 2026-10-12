import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { createBilibiliSetup } from './configure-bilibili.mjs'

// Only a temporary environment and a fake reload are used. No account or platform request occurs.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = resolve('data')
const dir = mkdtempSync(join(root, 'bili-setup-ui-'))
const envPath = join(dir, '.env')
writeFileSync(envPath, 'DEEPSEEK_API_KEY=fixture-preserved\n')
let applied = 0
const server = createBilibiliSetup({
  envPath,
  fetchImpl: async (url) => {
    assert.equal(url, 'http://127.0.0.1:8787/api/bilibili/reload')
    applied++
    return Response.json({ ok: true })
  },
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  const errors = [], outside = []
  const base = `http://127.0.0.1:${server.address().port}`
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== base) {
      outside.push(route.request().url())
      return route.abort()
    }
    return route.continue()
  })
  await page.goto(base)
  assert.equal(await page.getByRole('link', { name: '打开 B站身份码入口' }).getAttribute('href'), 'https://play-live.bilibili.com/')
  await page.getByText('在 B站页面右上角点“身份码”', { exact: false }).waitFor()
  assert.equal(await page.locator('#value').getAttribute('type'), 'password')
  await page.locator('#value').fill('fixture-private-identity#literal')
  await page.getByRole('button', { name: '保存并应用' }).click()
  await page.getByRole('status').filter({ hasText: '配置已保存并生效' }).waitFor()
  assert.equal(await page.locator('#value').inputValue(), '')
  assert.ok(!(await page.locator('body').innerText()).includes('fixture-private-identity'))
  const env = parseEnv(readFileSync(envPath, 'utf8'))
  assert.equal(env.BILIBILI_ANCHOR_CODE, 'fixture-private-identity#literal')
  assert.equal(env.DEEPSEEK_API_KEY, 'fixture-preserved')
  assert.equal(applied, 1)
  await page.reload()
  assert.equal(await page.locator('#value').inputValue(), '')
  await page.locator('#kind').selectOption('room')
  assert.equal(await page.locator('#value').getAttribute('type'), 'text')
  await page.locator('#value').fill('123')
  await page.getByRole('button', { name: '保存并应用' }).click()
  await page.getByRole('status').filter({ hasText: '配置已保存并生效' }).waitFor()
  assert.equal(parseEnv(readFileSync(envPath, 'utf8')).BILIBILI_ANCHOR_CODE, '')
  assert.equal(applied, 2)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.deepEqual(errors, [])
  assert.deepEqual(outside, [])
  await page.screenshot({ path: 'data/blivechat-setup-mobile.png' })
  const result = { kind: 'isolated local setup UI with temporary credentials', errors, outside,
    checks: ['masked code entry', 'save and reload source', 'preserve other credentials',
      'clear input and never prefill code', 'room alternative', '390px layout'] }
  writeFileSync('data/blivechat-setup-browser-result.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  assert.ok(realpathSync(dir).startsWith(root + sep))
  rmSync(dir, { recursive: true, force: true })
}
