import type { DirectorHandbookResponse } from './cohost-director-contract'
import type { StatusFrame } from './cohost-status-contract'

import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { createI18n } from 'vue-i18n'

import CohostDirectorSettings from './cohost-director-settings.vue'

import { statusEvent } from './cohost-status-contract'

it('edits in native settings, preserves drafts during live updates and drops drafts on character changes', async () => {
  let writer: ReadableStreamDefaultController<Uint8Array> | undefined
  const frame: StatusFrame = { kind: 'snapshot', epoch: 'test', revision: 0, status: {
    live: false,
    deepseekConfigured: true,
    busy: false,
    muted: false,
    hostSpeaking: false,
    bilibili: { source: '', configured: false, state: 'idle', error: null, roomId: null, received: 0, accepted: 0, dropped: 0 },
    configuration: { model: 'fixture', persona: '小鲸鱼', cardId: 'whale', cardFingerprint: '', profileStage: '', profileRevision: '', recognition: '', speech: '', voice: '', speechBackend: 'qwen' },
    room: { session: 'test', version: 0, entries: [] },
    performance: null,
    airi: { active: false, capture: false, captureReady: false, ready: false, configured: false, stages: [] },
    directorKnowledge: { handbookRevision: 'first', toolsRevision: 0 },
  } }
  let book: DirectorHandbookResponse = {
    revision: 'first',
    characterId: 'whale',
    learningEnabled: true,
    notes: [],
    persistent: true,
    error: null,
    manual: '本机 MCP 可以读取直播现场。',
    tools: { checking: false, connections: [{ id: 'live', transport: 'MCP', state: 'ready', error: null, checkedAt: 1, tools: ['live_context'] }], recent: [] },
  }
  const writes: unknown[] = []
  function publish() {
    if (frame.kind !== 'snapshot')
      throw new Error('Expected a snapshot fixture')
    frame.revision++
    frame.status.directorKnowledge = { handbookRevision: book.revision, toolsRevision: 0 }
    frame.status.configuration.cardId = book.characterId
    writer?.enqueue(new TextEncoder().encode(`${JSON.stringify({ ...statusEvent, body: frame })}\n`))
  }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    if (String(input).endsWith('/status/events')) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        writer = controller
        publish()
      } }))
    }
    if (!String(input).endsWith('/director-handbook'))
      throw new Error('Unexpected settings request')
    if (options?.method === 'POST')
      writes.push(JSON.parse(String(options.body)))
    return Response.json(book)
  })
  const screen = await render(CohostDirectorSettings, {
    global: { plugins: [createI18n({ legacy: false, locale: 'zh-Hans', messages: { 'zh-Hans': {} } })] },
  })
  try {
    await screen.getByRole('button', { name: '添加反馈' }).click()
    await screen.getByRole('textbox', { name: '适用情境（最多 100 字）' }).fill('轻松趣事')
    await screen.getByRole('textbox', { name: '希望怎样改进（最多 180 字）' }).fill('轻快接梗，仍让搭档讲完')
    await screen.getByRole('button', { name: '保存', exact: true }).click()
    expect(writes).toEqual([{ revision: 'first', characterId: 'whale', change: { operation: 'remember', situation: '轻松趣事', guidance: '轻快接梗，仍让搭档讲完', scope: 'context', duration: 'persistent' } }])
    await screen.getByRole('button', { name: '添加反馈' }).click()
    await screen.getByRole('textbox', { name: '适用情境（最多 100 字）' }).fill('保留的草稿')
    book = { ...book, revision: 'learned-during-edit' }
    publish()
    await expect.element(screen.getByRole('status').filter({ hasText: '手册已更新' })).toBeVisible()
    await expect.element(screen.getByRole('textbox', { name: '适用情境（最多 100 字）' })).toHaveValue('保留的草稿')
    await expect.element(screen.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    book = { ...book, characterId: 'other-character', revision: 'other' }
    publish()
    await expect.element(screen.getByRole('button', { name: '取消编辑' })).not.toBeInTheDocument()
    expect(writes).toHaveLength(1)
  }
  finally {
    screen.unmount()
    writer?.close()
    vi.unstubAllGlobals()
  }
})
