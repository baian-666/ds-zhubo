import { setTimeout } from 'node:timers/promises'

// A deterministic timing fixture. It never sends data to a model provider.
export async function* mockReply({ input, signal }) {
  const text = input.source === 'viewer'
    ? '看到这条弹幕了。主播，你想先聊这个问题，还是继续刚才的话题？'
    : '我接到你的话了。可以先从一个具体的例子聊起，再把话轮交回给你。'
  for (const piece of text.match(/.{1,5}/gu)) {
    await setTimeout(100, undefined, { signal })
    yield piece
  }
}
