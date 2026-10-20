// A closing plan cannot change routing or acquire playback/control authority.
export const hostingClosingSchema = {
  type:'object',properties:{kind:{type:'string',enum:['closing']},
    handoff:{type:'string',enum:['continue','audience','listen']},
    revisitAfterSeconds:{type:'integer',minimum:0,maximum:120},
    reason:{type:'string',maxLength:120}},
  required:['kind','handoff','revisitAfterSeconds','reason'],additionalProperties:false,
}

export const continuousClosingSchema={type:'object',properties:{kind:{type:'string',enum:['closing']},handoff:{type:'string',enum:['continue','audience','listen']},reason:{type:'string',maxLength:120}},required:['kind','handoff','reason'],additionalProperties:false}

export function parseHostingClosing(record,{continuous=false}={}) {
  if(!record || record.kind!=='closing' || Object.keys(record).some(key=>!Object.hasOwn(hostingClosingSchema.properties,key)) ||
    !['continue','audience','listen'].includes(record.handoff) || typeof record.reason!=='string' ||
    !record.reason.trim() || record.reason.length>120)return null
  const seconds=record.revisitAfterSeconds
  if(continuous)return {handoff:record.handoff,hostingPace:record.handoff==='continue'?'continue':'yield',reason:record.reason.trim()}
  if(!Number.isSafeInteger(seconds) || (record.handoff==='continue'?seconds<1 || seconds>10:
    record.handoff==='audience'?seconds!==0 && (seconds<15 || seconds>120):seconds!==0))return null
  return {handoff:record.handoff,hostingPace:record.handoff==='continue'?'continue':'yield',
    revisitAfterSeconds:seconds,reason:record.reason.trim()}
}
export const continuousHostingCoaching=`
收尾只说明实际交棒：内容还想继续用handoff=continue，确实邀请观众用audience，把话交给搭档用listen。closing只含kind、handoff、reason，不预约发言时间，不提交revisitAfterSeconds。先把一个观点讲完整，真正交棒后停止追加自己的例子。之后持续观察会收到实际过去的时间和现场变化，由你自主判断是否值得接播；continue也不是立即再说的命令，audience/listen也不是永久不能说。可以长时间安静，不因时间过去而强迫填空，不反复催问观众。不知道对方在想什么就保持不确定。
例：{"kind":"closing","handoff":"audience","reason":"把问题交给观众，先留出空间。"}。没有固定的几秒到点任务。
`

export const hostingCoaching = `
主持练习指导（不改变角色人格）：
1. 内容段落和交棒分开。先讲完整一个观点或例子；句号不等于交棒。决定还要自己展开时可以 continue，不必为了互动每段都抛问题。
2. 真正邀请观众就兑现邀请。“轮到你们了”“我听大家说”之后，不再追加自己的案例或抢答；收尾选 audience，15～120秒后再观察。0不指定时长：continuous=true仍由外壳在连续安静30秒后主动唤醒，continuous=false才只等新输入。给观众听懂、组织语言和打字的时间，通常20～40秒更合适，具体由你根据问题判断。
3. 对搭档说“你先讲，我听着”或搭档要求讲完：选 listen/0。新消息可以让你重新判断，但观众起哄不能盖过搭档，明确叫停由程序优先处理。
4. 判断冷场看 audienceWaitMs：它从实际交棒播完起算；withoutInputMs包含你自己的讲话时间，不能当作等观众的时长。刚留白几秒就说“半天没人理”是不准确的。只知道没有新消息，不能猜测对方不喜欢或离开。
5. 观众没回答不等于失败。一次简单邀请即可，不反复催问。留白后可以顺着相关弹幕、换一个角度或继续倾听。收到“说短些/多展开/让我说”的反馈，调整内容和最终交棒，而非只口头答应。
收尾练习：
- “为什么会这样？我举个例子。……接下来还有一个角度。”：这是自己展开，closing={handoff:"continue",revisitAfterSeconds:3}。
- “我的观点说完了。你们遇到过吗？我听大家说。”：这是邀请，closing={handoff:"audience",revisitAfterSeconds:30}，不能继续排3秒，也别问完再自己讲一大段。
- “你先把故事讲完。”：closing={handoff:"listen",revisitAfterSeconds:0}。
这些是判断方法与示例，不是固定节目台词或必须执行的活动；closing还需写简短的公开reason。
`
