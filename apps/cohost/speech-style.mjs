export const speechStyles = ['neutral', 'happy', 'surprised', 'gentle']
export const normalizeSpeechStyle = value => speechStyles.includes(value) ? value : 'neutral'
export const speechStylePrompt = `说话语气按聊天上下文和本轮回答的用意选择，默认 neutral（自然平常，解释、严肃讨论也用它）。neutral也要自然口语表达；不要为了听起来自然就选择happy。happy 用于真正在庆祝、分享喜悦或轻松玩笑，开心时正常表达喜悦，不刻意压低成平淡语气；surprised 仅用于具体意外，普通问句不算惊讶；gentle 用于倾听烦恼、安慰、体谅和温和提醒。难过、损失或严肃话题不要开心或夸张惊讶。不要为了变化随机轮换语气，也不要仅凭关键词选择。一轮保持一种语气；缺省用 neutral。你只标记这四种表达意图，不指定或更换声音、性别、年龄、音高或扮演另一个说话人。实际发声服从当前语音模式，不把语气说明写进台词。`

// Optional model control, never caption/history/TTS text. Only a leading control
// can set the turn's style, so later chunks cannot change already queued speech.
export async function* styledText(chunks, onStyle) {
  const marker = '<voice:'
  let buffer = '', control = false, discarded = false, spoken = false, selected = false
  for await (const chunk of chunks) {
    buffer += chunk
    while (buffer) {
      if (control) {
        const end = buffer.indexOf('>')
        if (end < 0) { if (buffer.length > 64) { buffer = ''; discarded = true }; break }
        if (!spoken && !selected) {
          onStyle(normalizeSpeechStyle(discarded ? undefined : buffer.slice(0, end)))
          selected = true
        }
        buffer = buffer.slice(end + 1); control = false; discarded = false
        continue
      }
      const start = buffer.indexOf('<')
      if (start < 0) { if (buffer.trim()) spoken = true; yield buffer; buffer = ''; break }
      if (start > 0) { const text = buffer.slice(0, start); if (text.trim()) spoken = true; yield text; buffer = buffer.slice(start) }
      if (buffer.startsWith(marker)) { buffer = buffer.slice(marker.length); control = true; continue }
      if (marker.startsWith(buffer)) break
      spoken = true; yield '<'; buffer = buffer.slice(1)
    }
  }
  if (buffer && !control && !marker.startsWith(buffer)) yield buffer
}
