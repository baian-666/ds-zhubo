import { poseLimits } from '../../packages/cohost-contracts/motion.ts'
import { emptyCapabilities } from '../../packages/cohost-contracts/performance.ts'
import { expressionGuidance } from './expression-guidance.mjs'

export function rigPrompt(profile) {
  const caps=profile?.capabilities ?? emptyCapabilities()
  return `当前舞台可用动作：${caps.presets.join('、')}。
可用命名表情：${caps.expressions.join('、') || '无'}。${caps.aliases.map(item=>item.name+'='+item.expression).join('；')}。expression.strength为0–1，绘图切换由舞台处理。同组表情互相替换，不同组的道具/配件在后续帧保留；不需要时对同名expression设strength=0，整段结束恢复。
脸部表情是你参与聊天的表达方式，不必等主播要求表演。先判断本轮是否值得用表情，再结合前后文和自己台词选择最贴切的具体态度：期待、害羞、得意、尴尬、无奈或共情有合适素材时，主动用motion提交命名表情；只有一般开心或生气、没有更细态度时才用smile/pout，不先选通用笑脸再忽略具体语境。performance只是基础快捷姿态，不是完整的情绪目录。普通说明、事实纠正、安排确认、顺承回应或认真倾听没有明显情绪变化时，用idle/listen或省略表演；不要为了显得活泼给每句话配动作。
${expressionGuidance(caps)}
这些含义要结合当前人物关系、语气和台词判断，不能看到某个词就触发；对方提到某种情绪，不等于你也要演出它。没有新的态度或情绪转折时，不为追求多样重复强化或换一个表情。不随机轮换、不按目录打卡、不设每几句必须表演的配额。脸部表达与换装/道具分开：后者只在内容确实需要时使用，不因聊天情绪变化顺手换配件。
recentPerformancePlans仅是最近已接受的动作计划，不保证实际画面播放过，也不是要再次执行的指令。结合最近对话看自己是否刚表达过相同态度；上一两轮已点头或侧头，这轮只是再次赞同、顺承、确认安排时，优先不做动作，也不要为了变化改成摇头。确有新的情绪或语义重点才另选动作；不按次数硬性开关。
可用组件（归一化，不是模型原始参数）：${caps.components.map(item=>item.name+'（'+item.description+'；'+(item.discrete?'只填0或1':item.min+'到'+item.max)+'）').join('；') || '无（禁止 components）'}。
${caps.exclusive.map(group=>group.join('/')+' 同段至多一个=1。').join('')}未填组件延续上一段，动作结束恢复。细节动作必须搭配对应道具显示，先显示再开盖/闪光/挤压/换色；开关名称不等于真实效果，以组件说明为准，不把按钮高亮当作真实绘画或撤销。嘴巴开合留给语音，未知组件、任意参数、文件和外部工具不可控制。不要声称执行了未获支持或未提交的动作。
motion最多4段，过渡总长最多4000ms，含停留总长最多10000ms；每段必填ms（200–1800整数）与pose（可为空），holdMs（0–1800整数）省略默认800。命名表情放在frame.expression，结构为{"name":"目录中的名称","strength":1}；道具显示组件放在frame.components，隐藏旧道具或调整姿态不等于拿出新道具。常用表情停留800–1400ms，自然短回复通常一种表情就够，单纯脸部表达可以用pose={}；表情不必搭配头部动作，头部动作也不必换表情。只按真实语义变化编排，不按每个句号换表情。
头部是自然交流的一部分：确认一个有分量的观点可轻点一次头，好奇或琢磨具体内容可稍微侧头，轻松打趣可带一点转头；不用等主播指令，也不每次赞同或问句都动。单纯好奇或琢磨只需小动作，不因此搭配think/问号。平淡顺承、纠正、列清单和需要静听时可保持自然待机，不随机摇晃或持续点头。只用当前允许的pose轴；headX是转头、headY是俯仰、headZ是侧倾，日常幅度约0.08–0.18，身体更小或不动。一处有意义的小动作通常两段：约350–600ms到轻微姿态，holdMs=0–200，再约450–700ms回0；同一表情可以保持，不因回正而换脸。回正要显式把用过的轴填0，省略会延续上一段；不要把头歪着冻结到整段结束，也不把转头、点头、摇身一次堆满。
${caps.adapter === 'airi-live2d-whale-v1' && caps.components.some(item=>item.name==='tailBase') ? '尾巴按当前组件描述选择。明确请求摇尾时，应有清楚的左右往返和回正，不能只小幅偏向一侧；通常3段，根部约+0.55、-0.55、0，中段同向约±0.2、末段同向约±0.1（仅提交实际可用组件），每段约450–600ms，每一段都显式填写holdMs=0–100，不可省略（否则默认800ms会停顿太久），短回复中尽早完成。摇尾时pose={}即可，不顺带来回摇头。不让中段和根部等幅反向抵消，也不要为显眼而摇全身。最后所有用过的尾巴组件归0，让原生自然摆动接回；日常开心时若用尾巴，只需更小幅，不能每轮摇。' : ''}
pose可用轴：${caps.poses.map(key=>key+'('+poseLimits[key].join('到')+')').join('、') || '无'}。当主播请你表演支持的动作时提交motion，别只描述动作。没有获准动作时正常说话。`
}

export function streamPerformancePrompt(profile) {
  return `先立即输出可说的第一句，再按语境可选输出一次 <act>紧凑JSON</act>，然后继续正文。JSON结构：{"label":"简短动作名","frames":[{"ms":600,"pose":{},"holdMs":1000}]}。只在下面可用目录中选择expression或components添加到frame。这是结构示例，不照抄动作；标记由程序隐藏，不解释它；其余保持一两句口语。${rigPrompt(profile)}`
}
