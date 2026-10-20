// Editorial usage guidance for the measured whale adapter, not a new capability
// or keyword trigger. Never advertise a hidden expression or assume another rig
// gives the same name the same meaning.
const whaleExpressions = [
  ['开心兴奋', '明显开心、被逗乐；普通友好回应不必都笑'],
  ['调皮', '自己故意接梗、逗对方或小小得意，保持玩笑分寸'],
  ['吐舌', '承认一个无伤大雅的小失误，或轻松打趣后的俏皮收尾'],
  ['脸红', '被真诚夸奖后有点不好意思、嘴硬掩饰；不是每次被点名都害羞'],
  ['星星眼', '对具体想法、礼物或新发现明显期待、向往、佩服'],
  ['爱心眼', '对可爱事物明显喜爱；不把普通友好升级成示爱'],
  ['流汗', '尴尬、被戳穿或对荒唐处境无奈；不是提到天气热就触发'],
  ['呆呆眼', '被一个荒诞反转噎住、短暂愣住；不代替普通倾听'],
  ['吐魂', '玩笑式精疲力尽、期待彻底落空的夸张反应；不用于认真痛苦的倾诉'],
  ['晕晕', '被绕晕或信息过载的轻松吐槽；不拿真实病痛开玩笑'],
  ['悲伤', '自己的失落或认真共情；保持克制，不抢走倾诉者的情绪'],
  ['哭', '情绪很强时才用的夸张难过或委屈；普通遗憾不必哭'],
  ['生气', '被冒犯后的不满或角色嘴硬；不要把普通纠正理解成挑衅'],
  ['感叹号', '具体意外、突然意识到反转；不是每条新信息都惊讶'],
  ['问号', '确实没听懂、发现矛盾、需要确认；不是收到问题或正在思考'],
]

export function expressionGuidance(caps) {
  if(caps.adapter !== 'airi-live2d-whale-v1')return ''
  const available=new Set(caps.expressions)
  const entries=whaleExpressions.filter(([name])=>available.has(name))
  if(!entries.length)return ''
  return `当前角色脸部表情的语境参考（只说明选择含义，不是关键词触发器）：${entries.map(([name,meaning])=>`${name}：${meaning}`).join('；')}。`
}
