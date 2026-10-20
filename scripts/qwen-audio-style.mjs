// Audition presets retained for reproducible experiments. Production Qwen requests
// no longer import these: the user selected instruction-free delivery.
export const qwenNaturalInstruction = '保持原音色，自然口语表达，停顿和重音随语意，语速适中。'
const instructions = Object.freeze({
  neutral: '语气平和。',
  happy: '用轻快、带一点笑意的语气说话，像和熟悉的朋友分享开心的事。自然克制，不要喊叫或刻意大笑，保持原音色。',
  gentle: '用温和、体谅、耐心的语气说话，像在认真陪伴和安慰朋友。语调柔和，停顿自然，不要欢呼、哭腔或刻意耳语，保持原音色。',
  surprised: '用轻微意外、好奇的语气说话，重音和起伏适度，像朋友间自然的惊讶。不要尖叫或夸张表演，保持原音色。',
})

export function qwenAudioInstruction(style) {
  const selected = typeof style === 'string' && Object.hasOwn(instructions, style) ? style : 'neutral'
  return qwenNaturalInstruction + instructions[selected]
}
