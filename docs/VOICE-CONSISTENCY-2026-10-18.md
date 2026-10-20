# 宵宫长回复中途变声排查

**当前生效：用户实际聊天后不满意带指令方案，已要求并完成恢复无指令发声。Qwen所有语气都不发送instruction。下方试听及首次启用过程是历史证据，不能据此重新开启指令。**

2026-10-18。用户要求允许情绪变化但保持音色身份。最初按13:33餐厅表演「中途换人」排查，用户随后澄清：是整段音色与上一段不同，不是句间突然切换。下方分段对照保留为早期探索，不能作为该反馈的根因结论。正式服务未修改或重启，未宣称听感问题已修复。

## 已确认

- 实时房间记录turn20为happy，上一轮turn17为neutral，speechRevision均为`9940667a-1aca-4aee-9205-a6ba65d56561`。实际供应商是Qwen，型号qwen-audio-3.1-tts-flash；本轮没有切换声音配置。
- 服务端向每次合成传递同一个话轮speechStyle。克隆音色编号由服务器配置固定，配置修订不匹配会拒绝旧话轮，客户端不能指定另一个声音。当前实现无自动回退到另一个音色。
- [媒体桥](../integrations/airi/use-cohost-media-host.ts)按句末分段，boost=0、maximumWords=24；[语音客户端](../scripts/qwen-audio-client.mjs)每个片段独立run-task、finish-task。连接复用不等于复用一个连续合成任务。原回复按当前分段器重建为4段；原始导演speech记录边界没有保存，不能当作事故现场逐请求回放。
- 每段happy指令一致，rate/pitch均1。字幕下的「惊喜到满足」是动作标签，不是中途语音情绪切换。
- [官方说明](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)明确instruction能控制情感和音色特点。现有提示中的「保持原音色」不是硬性声纹约束。固定编号/固定pitch不等于生成波形的人物感必然稳定。

## 推断与限制

独立分段任务在交界处重新生成表达，以及情绪指令对音色特点的影响，是需要区分的两个因素。尚无事故原音频听审，不能确定当时具体变化位置或把原因认定为其中一个；也未排除供应商同一任务内漂移。未用音高或响度指标冒充音色一致性评估。

## 隔离真实对照

[脚本](../scripts/voice-consistency-trial.mjs)、[完整报告](../data/voice-consistency-20261018/run-02/report.json)。读取既有台词及声音配置，不创建新声音，不上传参考录音，不写聊天/设置，不在舞台播放。任务开始时会话空闲。

| 对照 | 实际云端任务 | 时长 | 文件 |
| --- | --- | --- | --- |
| A 分段 | 4段各生成一次，按原顺序拼接 | 27.96秒 | [试听](../data/voice-consistency-20261018/run-02/segmented.wav) |
| B 连续 | 1个任务，4次continue-task，120ms间隔，最后finish-task | 27.48秒 | [试听](../data/voice-consistency-20261018/run-02/continuous.wav) |

两版台词、克隆编号、模型、happy指令、rate/pitch相同。均为24kHz单声道PCM16、非静音、有限值、零满幅削波。音色与.env文件指纹、运行时speechRevision前后相同。A拼接不保留网络供给间隙，本次不比较首声或播放延迟，也不是原事故录音。每种方案只生成一次，没有挑选结果。

run-01在受限网络下失败，未形成云端任务/音频，失败记录保留。升级网络权限首次被自动审批拒绝；补充只读证据证明输入为助手已通过同一服务说过的虚构餐厅台词后，同一操作复审通过，run-02完成。没有绕过审批或改用其他目的地。

[官方协议](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-client-events)支持同一任务内多次continue-task。本次只在隔离传输包装器中验证，未把它直接替换进正式分句播放链路。新脚本已通过语法检查；生产代码未变，不需要重跑应用测试套件。

## 下一步

用户已澄清为整段与前一段音色不同，暂不推进分段链路修改。先用下述情绪指令单变量对照听审；未经用户要求，不修改正式声音配置。

## 澄清后：开心指令有无对照

用户明确要求同一句台词做有开心指令／没有开心指令两版，先别改正式配置。使用同一段138字餐厅原文、同一个已登记宵宫克隆、同一Qwen模型，各一个任务、一次完整文本提交、seed=0、rate=1、pitch=1。唯一请求参数差异是instruction：A完全不发送，B使用现有happy原指令，不改写台词或提示。

- [A 无开心指令](../data/voice-happy-ab-20261018/run-01/01-no-instruction.wav)：23.33秒。
- [B 有开心指令](../data/voice-happy-ab-20261018/run-01/02-happy-instruction.wav)：28.05秒。
- [参数与验证报告](../data/voice-happy-ab-20261018/run-01/report.json)、[隔离脚本](../data/voice-happy-ab-20261018/audition.mjs)。每版只生成一次，均24kHz单声道PCM16、有限值、非静音、零满幅削波。实际请求核对onlyInstructionDiffers=true；.env、克隆元数据、生产情绪映射文件指纹及运行时声音修订前后一致。脚本语法检查通过，没有生产源码修改，不运行应用全套测试。

无指令仍允许模型根据文本自然表达，并不等于强制无情绪。音色差异及偏好待用户听审；时长差异是本次样本结果，不是固定规律或速度结论。

## 用户听审反馈与统一自然指令试听

用户听完有／无开心指令后确认差异与开心指令有关，认为有指令版更像真人、更自然，但与平时声音不同。用户明确授权下一轮两版试听，暂不更改正式配置。

两版共用基础提示：「保持原音色，自然口语表达，停顿和重音随语意，语速适中。」日常只追加「语气平和。」，开心只追加「语气略带喜悦。」不添加新的性别、年龄、角色或音色特征描述。这是提示策略实验，不是声纹锁定保证。

- [A 自然日常](../data/voice-natural-ab-20261018/run-01/01-natural-everyday.wav)：25.81秒。
- [B 自然轻开心](../data/voice-natural-ab-20261018/run-01/02-natural-happy.wav)：26.53秒。
- [请求与验证报告](../data/voice-natural-ab-20261018/run-01/report.json)、[隔离脚本](../data/voice-natural-ab-20261018/audition.mjs)。同一段餐厅原文、宵宫克隆、模型、seed0、rate1、pitch1、单任务完整文本提交，每版一次。实际请求只差情绪后缀。
- 两个WAV均24kHz单声道PCM16、有限值、非静音、零满幅削波；.env、克隆元数据、生产情绪映射文件指纹及运行时声音修订未变。脚本语法检查通过。未修改/重启服务，未在舞台播放，未改生产源码。

待用户判断两版是否仍像同一个人、是否保留自然表达。机器检查只验证文件有效性，不代表人工听审通过。前述无指令方案的「待听审」已由本节用户反馈更新。

## 不同场景，恢复原开心指令

用户反馈第二轮开心程度降低，要求不要减弱开心，并分别使用日常闲聊和分享开心事的文本。已解释上轮把原happy指令改成「语气略带喜悦」，确实降低了提示中的情绪要求。

本轮日常维持统一自然基础提示＋「语气平和。」；开心使用相同基础提示＋生产`qwenAudioInstruction('happy')`完整原文（轻快、带笑意、向朋友分享开心事），不再使用「略带喜悦」。正式生产映射保持原样，本轮覆盖仅在隔离请求中生效。

- [日常闲聊](../data/voice-natural-scenes-20261018/run-01/01-casual-chat.wav)：天气、泡茶和休息时喜欢做什么，13.73秒。
- [分享开心事](../data/voice-natural-scenes-20261018/run-01/02-happy-news.wav)：终于抢到期待的演唱会门票，14.13秒。
- [完整台词、指令与验证报告](../data/voice-natural-scenes-20261018/run-01/report.json)、[脚本](../data/voice-natural-scenes-20261018/audition.mjs)。台词均为专门编写的虚构试听内容，不是角色真实经历。两版文本与情绪指令同时不同，用于场景听感，不作为单变量因果实验。

每版生成一次，同一宵宫克隆/模型/seed0/rate1/pitch1，单任务完整文本提交。原happy指令完整保留、提交台词准确和公共生成参数一致均已核对。24kHz单声道PCM16、非静音、有限值、零满幅削波；文件/运行时配置未改，未重启或播放到舞台。脚本语法检查通过，音色一致性、自然度和开心程度待用户听审。

## 用户通过并正式启用

用户确认上一节版本可用，明确授权用于小鲸鱼，要求导演和语音协调、日常自然、开心保持认可程度。此前「禁止修改正式配置」限制已被本次启用授权替代。

- [Qwen映射](../scripts/qwen-audio-style.mjs)：所有发声请求都带统一自然基础指令。neutral与happy逐字匹配通过试听的报告；happy保留完整原指令，不降为「略带喜悦」。gentle/surprised沿用原情绪描述并增加同一基础。缺失、未知、非法类型统一回退自然neutral，不再产生无指令发声。无文字的连接预热仍不发送表达指令。
- [导演提示](../apps/cohost/speech-style.mjs)：neutral也要自然，不为自然度滥选happy；开心时正常表达，不刻意压低。只选择四个预设，不指定声音身份、性别、年龄、音高。自动参与、短反应、预生成和手动隐藏标记继续沿原话轮传递speechStyle，不增加LLM调用。
- 服务端从当前话轮取语气，整轮多句保持一致；客户端伪造语气、后续speech记录的新语气不会覆盖第一条decision。取消、声音修订和已播进度规则保留。Qwen固定seed0，与试听相同；音色ID、rate1、pitch1、分句/并发/首声策略均未改。此处保证请求一致，不承诺云端生成声纹绝对不漂移。
- `npm run check`、`npm test`（440项）通过。新增HTTP→流式导演→真实Qwen适配器/模拟WebSocket测试，覆盖happy/neutral/缺省、每轮两句、迟到风格和客户端覆盖无效、一次模型调用。既有手动语气隐藏与预生成风格传递检查通过。端到端音频为模拟PCM，不当成新增真人试听；真实样本直接沿用用户已通过的两条，未重复付费合成。
- 空闲且关麦后仅重启后端，新PID288076。SQLite备份`data/voice-natural-deploy-20261018/session.before.sqlite`，原源码备份同目录`before/`。300条原聊天、runtime_settings/module_settings全部行、角色、声音型号和克隆元数据、.env核对保留；未重启桌面/Index、未启动收音。后端健康。用户后续真实长聊仍需观察情绪贴合与音色一致性。

[部署审计](../data/voice-natural-deploy-20261018/deployment.json)、[语法检查](../data/voice-natural-deploy-20261018/check.log)、[完整测试](../data/voice-natural-deploy-20261018/tests.log)。首次新增测试的模拟流缺失结束元数据而超时，补齐fixture后单测及全套通过；生产代码没有为此放宽流式协议。

## 实际聊天后恢复无指令版（当前）

用户表示接上后的感觉不如之前，明确要求「不带指令」。已从Qwen生产客户端移除指令映射导入及instruction参数构造，全部speechStyle均不发送指令，不只是neutral省略。保留宵宫克隆、模型、seed0、rate1、pitch1，按文字由TTS自行表达。历史提示函数仅保留供隔离实验，生产客户端不使用。

导演可以保留speechStyle意图元数据及原表情/动作，但不能通过它重新启用Qwen指令；发声能力快照emotion=false，界面不再宣称Qwen指令控制开启。导演提示说明实际发声服从当前语音模式，不把控制说明写进台词。没有回退其他任务功能或覆盖旧SQLite。

`npm run check`及440项Node测试通过，覆盖happy/neutral/gentle/surprised/未知/缺失均不含instruction、连接复用不遗留指令、导演多句及客户端覆盖也不能加回指令。空闲关麦备份后仅重启后端，新PID265460，healthz通过；300原聊天、全部持久设置行、角色/克隆/.env均保留，未重启桌面、未启麦、未重复生成试听。

[部署审计](../data/voice-no-instruction-deploy-20261018/deployment.json)、[语法检查](../data/voice-no-instruction-deploy-20261018/check.log)、[测试](../data/voice-no-instruction-deploy-20261018/tests.log)。备份在`data/voice-no-instruction-deploy-20261018/session.before.sqlite`，源码原件在同目录`before/`。以后要再加指令，需用户重新要求，不能把之前两条试听通过当作持续授权。
