import assert from 'node:assert/strict'

// Read-only configuration verification: no provider calls, microphone or settings writes.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const desktop = await chromium.connectOverCDP('http://127.0.0.1:9250')
let web
try {
  const pages = () => desktop.contexts().flatMap(context => context.pages())
  const stage = pages().find(page => page.url().includes('synced-leader=true'))
  assert.ok(stage, 'Desktop stage must be running')
  assert.equal(await stage.locator('[data-cohost-panel]').count(), 1)
  await stage.locator('[data-cohost-panel]').getByRole('button', { name: /^(直播助播|Live cohost)$/ }).click()
  let settings
  for (let attempt = 0; attempt < 40; attempt++) {
    settings = pages().find(page => page.url().includes('/settings/modules/cohost'))
    if (settings) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(settings, 'Native settings window opens on the cohost route')
  const verify = async page => {
    await page.getByText(/^(小鲸鱼的声音|Cohost speech)$/).waitFor({ timeout: 60000 })
    await page.getByRole('link', { name: /^(表情包设置|Sticker settings)$/ }).waitFor()
    assert.equal(await page.locator('[data-bilibili]').count(), 1)
    assert.equal(await page.locator('[data-cohost-panel]').count(), 0)
  }
  await verify(settings)
  await settings.screenshot({ path: 'data/native-settings-desktop.png' })
  web = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await web.newPage({ locale: 'zh-CN' })
  await page.addInitScript(() => localStorage.setItem('onboarding/completed', 'true'))
  await page.goto('http://127.0.0.1:5173/settings/modules/cohost')
  await verify(page)
  await page.screenshot({ path: 'data/native-settings-web.png' })
  console.log('PASS: one desktop panel, native settings navigation, actual voice configuration, shared web settings')
}
finally {
  await web?.close()
  await desktop.close()
}
