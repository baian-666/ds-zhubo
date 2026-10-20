# 等待与短回应完整度：2026-10-19

本轮目标是稳定两秒内开口，并减少中途短回应被切断。**尚未达到稳定两秒，也没有证明完整回答比上轮稳定更快**。修复已更新到本机；同一代码最终两遍故事等待3.58、3.33秒，5个中途短回应全部完整，附和/接管两素材回归通过。中间两遍因余额不足无声；用户恢复余额后已完成上述最终复测，失败样本仍保留。

## 实现

- 识别音频每个32ms VAD帧即可上传，仍串行校验顺序、限制积压。候选能在语音事件和舞台心跳到来时消费；收音/播放期间心跳50ms，空闲维持较低频率。
- **分场景分段**：倾听时320ms；普通回答期间恢复原650ms，且正在识别的附和片段保留长窗口。200ms微停顿入口、640ms不明先暂停、1800ms仍不明取消保持原值。全局320ms版本实际误停过附和，已淘汰。
- 直接回答的首项允许省去解释性reason，优先一个完整短分句。清理“第一项必须decision”与answer格式的矛盾；观察状态下的主播直接回答也可走紧凑格式。控制、查询、学习与主持权限仍使用原校验。追踪实际firstRecordKind，不把提示词当作已经生效的证据。
- 中途反应优先一声，仍由模型按语境选择，保持3.5秒冷却。提前准备完整PCM并裁掉外侧静音，再进入停顿；声线、Qwen模型与无instruction规则保持。
- 已经播放的短反应，只在**完整音频≤700ms、音频时钟确认剩余≤180ms**时允许收尾一次。输入绑定当前turn/audioId，不能续期；长回答不使用这条许可，明确停止和内容失效仍取消。
- 前端按实际剩余音频结束，并设≤180ms硬截止。后端保留同一180ms上限用于接收有序的播完回执，避免完整音频被抢先标成取消。不是把180ms加到普通接管阈值上。
- 后端与前端共用`acknowledgmentExtension`。同一输入、同一输出的已审核附和，仅新增有界的附和后缀时保留语义判断；改口、接管、新观点、换话轮仍拒绝旧结果。修正后端原先一律拒绝文字变化、导致前端已有保护接不到许可的问题，超时值不变。
- 原完整草稿试验仍默认关闭。局部分段后准备只在最终转写一致时复用；正常判断照常竞速，不为等待草稿延长原截止。

源码：[语音桥](../integrations/airi/use-cohost-voice.ts)、[媒体播放](../integrations/airi/use-cohost-media-host.ts)、[尾音边界](../packages/cohost-contracts/listening-tail.ts)、[上传](../integrations/airi/streaming-recognition.ts)、[PCM准备](../apps/cohost/prepared-speech.mjs)、[导演](../apps/cohost/director.mjs)、[首项格式](../apps/cohost/participation-stream.mjs)、[服务调度](../apps/cohost/server.mjs)。AIRI修改均有integrations/scripts重放来源，不只存在于vendor。

## 方法与保留的失败

使用原三份合成WAV，经真实浏览器麦克风输入、VAD、Fun-ASR、DeepSeek、Qwen和WebAudio录制。用户已授权这些素材发送原服务。没有注入转写或模拟接管事件；但这不是真人、物理麦克风/扬声器或主观自然度试听。首声等待按录制的输入尾音到输出首声计算，约10ms分辨率；服务回执时间另列，不能冒充声学时间。

输入SHA256不变：

- 故事：`e226b2125e830c08efde52415a88b644a70e6156ed792d544f613f05586dcb6b`。
- 附和/接管：`8ee8e1b86688173645d201242c2d684f7e528d9ac31fbff313d5fea8751ecb84`。
- resume：`3de6f0009dd426da1bcf28d33f6a3ee80042cfc7919a31377c3364ced9121ed6`。

| 阶段/文件前缀 | 故事末尾到首声 | 中途短回应 | 结论 |
| --- | --- | --- | --- |
| 上轮first-sentence-reserve-story-1 / final-story-2 | 3.21 / 2.62秒 | 均未完整 | [上轮报告](FIRST-SENTENCE-LATENCY-2026-10-19.md) |
| two-second-candidate-story-1 | 2.64秒 | 1完整、1截断 | 450ms分段候选，不是达标 |
| two-second-compact-story-1 | 3.52秒 | 1完整、1截断 | 云端波动；“观察状态排除”不是此listen-only样本慢的原因 |
| two-second-endpoint-story-1 | 3.10秒 | 1完整、1截断 | 实际首项answer；末句确认1.95秒 |
| two-second-tail-story-1 | 2.92秒 | 2完整 | 尚未触发尾音许可 |
| two-second-adaptive-story-1 | 2.95秒 | 4完整 | 实际触发22ms尾音许可 |
| two-second-adaptive-story-2 | 3.99秒 | 2声录音均收完；1声被错误标取消 | 93.5ms尾音收完后，回执与截止竞争；随后修正 |
| two-second-release-story-1 | 2.79秒 | 2完整 | 回执修正后复测；仍非稳定两秒 |
| two-second-floor-story-1 / story-2 | 无输出，不能计时 | 无输出 | 最终附和许可修复后；第二遍记录30次HTTP402，余额接口确认不可用 |
| two-second-floor-story-3 | 3.58秒 | 2完整 | 余额恢复后，同一最终代码；普通回答竞速获胜、准备未复用 |
| two-second-floor-story-4 | 3.33秒 | 3完整 | 同一最终代码；实际175ms尾音许可，恢复讲话后150ms结束 |

`two-second-final-backchannel-1`（名称不是发布承诺）使用全局320ms，实际在3.73秒附和中hold/yield，**不合格**。分场景版本`two-second-adaptive-backchannel-1`：附和3.73秒无hold/yield，真正接管730ms停声、不复播；`two-second-adaptive-resume-1`普通回答740ms停声、不复播。随后把短反应后端完成回执截止统一为既有180ms上限，前端仍在实际音频结尾停止。

后续`two-second-release-backchannel-1`再次发现928ms附和短暂停，未取消但仍不合格：临时转写从“文，对对对”增加“你继续说”，模型已经判断backchannel，后端却因文字不完全相同丢弃结果。已用失败复现测试证明，再共享既有有限后缀规则修复，相关13项Node通过；不硬编码“文”等误识别文字。`two-second-release-resume-1`另有一次晚到的模型流json错误，开始播放前失败、没有输出音频，不能算接管通过。这些失败均保留。

文件均保留在`data/listening-audio-trial/<前缀>.json`、`-analysis.json`、`-summary.json`和原录音中。不能把生成文本完整或ended请求出现单独当作实际播放完整；例如第二遍adaptive的音频已收完而服务状态取消，必须对照波形、PCM长度和回执。

常见附属错误为未运行的`ws://localhost:6121/ws`；原始日志保留，不宣称浏览器零错误。模型代码20多数是过期预判/竞速取消；全局320ms误停样本另有一次json错误及取消后的409，不能掩盖。

## 等待仍未达标的证据

adaptive故事两遍最后转写确认约1.29、2.21秒；准备首项约1.16、1.08秒；首项准备完成到可听首声还要约0.86、0.83秒，其中准备过程部分与识别重叠。resume较慢样本中模型首项1.42秒、Qwen首PCM1.26秒，尽管均复用了语音连接/任务。一次DeepSeek TLS/HTTP2握手探测约71ms，仅是连通性与握手测量，不证明更换传输协议能节省一秒。

因此不能声称稳定两秒，也不能把减少本地等待直接等同于端到端收益。末句识别、模型首词和语音首包均有波动。下一阶段需要评估更早的、仍经最终输入校验的回答准备，以及ASR/首词服务本身的延迟；没有用固定垫话伪装完整回答提速。回答仍出现“谁给谁发工资”的主客体混淆，本轮没有解决模型内容质量。

最终故事第3遍：末句确认1.012秒，随后约259ms进入正式请求，模型首项950ms，语音首PCM879ms，首PCM到可听首声约403ms，总等待3.58秒。提前准备的首词更慢，正式生成竞速获胜；不是主动多等准备。第4遍末句确认1.359秒，准备请求1.353秒才开始、首项893ms，首PCM再755ms，可听首声3.33秒；虽复用了准备，重叠仍很少。这解释了为什么“边听边准备”机制可用，却未转化成稳定两秒。后续应提高更早准备的命中率，同时保留最终输入校验；继续缩短附和保护无法解决这段串行等待。

查阅了[百炼Fun-ASR客户端协议](https://www.alibabacloud.com/help/zh/model-studio/fun-asr-client-events)与[SDK发送建议](https://www.alibabacloud.com/help/en/model-studio/fun-asr-realtime-python-sdk)：结束任务仍等待全部音频发送完成；更小分片只是减少本地攒包，并非云端低延迟保证。云端`max_sentence_silence`仍650ms，上轮400ms无收益试验没有重新启用。

## 后续低延迟方案调研（尚未接入）

用户询问其他低延迟方案后，查阅了以下一手资料；本段是可验证的下一步，不是新模型实测。最终两遍“停口到最终转写可用”占总等待约28%/41%，包括本地分段、传输与服务收尾，不等于ASR模型纯计算耗时。转写是最大的单项，但模型首段与语音首包合计更久，应同时优化重叠程度。

1. [LiveKit预生成配置](https://docs.livekit.io/reference/agents/turn-handling-options/#preemptivegenerationoptions)：允许在话轮确认前生成答案，并可选提前TTS；限制长语句与尝试次数。[官方调优](https://docs.livekit.io/agents/logic/turns/tuning/)要求转写改变时取消旧回答，也提示预生成不一定实际降延迟。优先借鉴“提前计算、最后授权”，保持现有最终输入校验，记录准备领先时间、有效复用率与取消成本；不能把“开启了准备”当成已经并行。
2. [Pipecat Smart Turn](https://github.com/pipecat-ai/smart-turn/blob/main/README.md)提供直接读音频、支持中文的本地CPU/ONNX话轮结束判断。它判断说完还是续讲，不是附和/接管分类器，也不能替代转写。适合先旁路记录与原VAD对比，再决定是否让它参与结束确认。项目公布的推理耗时不是本机实测，更不是整条回答延迟。[LiveKit声学附和过滤](https://docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/)是另一类能力，其云端部署、对齐转写等要求也不能直接当成本地可用。
3. [Qwen-Omni-Realtime](https://www.alibabacloud.com/help/en/model-studio/realtime)可流式音频输入与音频输出，支持语义VAD，值得作为独立音频到音频对照。其[克隆接口](https://www.alibabacloud.com/help/en/model-studio/qwen-omni-voice-cloning)绑定target_model，当前Qwen TTS克隆不能假定直接兼容；角色、声音、导演控制与打断均需重新验收。尚未调用、创建音色或切换生产模型，也没有证据承诺它在本机两秒内。

建议顺序：先提高现有首句准备的提前量和复用率、拆清首PCM后330～400ms的排播/起音；同时做ASR末词完成时延对照与本地结束判断旁路评估；若三段串行瓶颈仍明显，再比较音频到音频路线。验收继续用原三份WAV和实际输出，分别看首声分布、短声完整、附和误停、接管停声，最后再做真人长聊。

## 最终复测、检查与部署

最终附和许可修复后的记录：

| 原素材 / 最终前缀 | 实际声音与行为 | 验收范围 |
| --- | --- | --- |
| 附和/接管 / two-second-floor-backchannel-1 | 首答2.35秒；附和29.05～32.79秒，期间无hold/yield；真正接管38.23秒，末声38.98秒，750ms停声，无复播 | 本样本附和不停、接管停止通过 |
| 继续讲话 / two-second-floor-resume-1 | 首答2.59秒；29.67秒继续说，末声30.41秒，740ms停声，无复播 | 普通回答接管通过；尾段另有provider错误，不能声称全程零故障 |
| 连续故事 / two-second-floor-story-1、story-2 | 两遍均无输出；第二遍30次模型响应均402 | 不合格样本，不能记作零延迟或短回应通过 |
| 连续故事 / two-second-floor-story-3 | 输入尾音69.08秒，正式首声72.66秒；两声短回应完整、正式63字播完 | 等待3.58秒，不达标；短回应通过 |
| 连续故事 / two-second-floor-story-4 | 输入尾音73.46秒，正式首声76.79秒；三声短回应完整、正式42字播完。第三声仅316ms，收到175ms尾音许可，输入恢复后约150ms结束 | 等待3.33秒，不达标；实际尾音边界通过 |

2026-10-19 20:02左右，官方余额接口HTTP200、`is_available=false`。HTTP402的含义为余额不足，见[DeepSeek官方错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)。只读核验记录`data/two-second-balance.json`；代理没有充值或换模型/密钥，并暂停云端调用。第一遍当时只记录provider错误，不能事后声称其每个请求均已记录402。用户随后明确“已恢复，继续真实复测”，第3、4遍恢复实际发声，第4遍23次已记录模型HTTP响应均200。

第3遍`userSessionUnchanged=true`；第4遍为false，不能省略这项异常。核查正式会话在该时段新增3条`mode_changed`、`viewer_window_changed`、`participation_changed`导演状态记录，试验与正式room session不同，试验完整记录的时间/角色/文字与正式记录交集为0。隔离试验未指定SessionStore，所有测试写请求路由至临时后端。随后正式桌面已在线（live=true、capture=false、stage=1）；没有回滚这些正式状态变化。证据`data/two-second-trial-isolation.json`。同机正式窗口活动也意味着不能把两遍视为严格受控性能实验。

可听录音为立体声左输入/右输出，裁去外侧空白，未改变内部时间关系：

- [最终故事第1遍](../data/listening-audio-trial/two-second-floor-story-3-listen.wav)：2次短回应完整、末尾等待3.58秒。
- [最终故事第2遍](../data/listening-audio-trial/two-second-floor-story-4-listen.wav)：3次短回应完整、末尾等待3.33秒，实际尾音收尾。
- [较早的回执修复样本](../data/listening-audio-trial/two-second-release-story-1-listen.wav)：2次短回应完整、末尾等待2.79秒；发生在最后附和许可修复前。
- [最终附和与接管](../data/listening-audio-trial/two-second-floor-backchannel-1-listen.wav)。
- [最终继续讲话](../data/listening-audio-trial/two-second-floor-resume-1-listen.wav)。

- 根级`npm run check`、`npm test`，484项Node通过。
- 4个相关Vitest文件、12项通过，含动态分段窗口；这是模拟/浏览器组件验证，不能替代上述真实云端音频。
- AIRI根类型55/55；lint修复两处新增格式错误后0错误、685警告，包含测试夹具类型断言提示。
- 固定网页`two-second-release-web`与桌面构建通过。新桌面`20261019T120419351Z-0ccd6e92`已实际运行，5174健康接口确认，见`data/two-second-running-desktop.json`；上一版`20261018T165057937Z-e0839924`保留。不等于真人Electron语音验收。
- 后端确认空闲关麦后由301084更新为282144，更新当时live=false、主持off、capture=false；300条聊天按原恢复规则逐字段一致，角色、手册、声音、服务与.env指纹保留，新桌面指针与预期一致。备份`data/session-backups/two-second-1792411523568.sqlite`，核验`data/two-second-deployment.json`。后续正式窗口状态变化见上段；最终三份原素材均已真实复测，首声两秒指标仍不合格。

日志：`data/two-second-final-check.log`、`two-second-final-tests.log`、`two-second-adaptive-vitest.log`、`two-second-floor-typecheck.log`、`two-second-floor-lint.log`、`two-second-desktop-build.log`。没有提交或覆盖密钥、重置既有修改，也没有用合成素材替代真人长聊验收。

## 后续优化：并行准备、起音与识别对照（2026-10-19）

用户授权继续实施，并要求长期无收益时学习或换思路。本次先复测原版，再修两个具体等待点；没有把未达两秒的结果写成完成。

- 局部VAD分段后的首句准备可与尚未结束的短回应判断并行，沿用现有两个任务槽与取消边界，不取消已经有用的短回应。最终转写一致、话轮结束后才能采用草稿；普通语音播放期间仍禁止进入该准备分支。
- 抽出共享`PcmOnset`：只去除Qwen回答首段的起始近静音，保留40ms起音余量。此前只有准备成功的首句会裁剪，回退到直接合成的首段仍有额外静音；后续句子和句内停顿保持原样。短回应完整PCM、700/180ms尾音规则、附和640/1800ms规则均未调整。
- 试验新增原始合成PCM的起音位置记录，区分服务首包、音频自带静音与浏览器播放。基线正式首句原始静音约208ms，裁剪后排播到实际声能约104ms；另一段续句曾带约1.7秒起始静音，属于后续语流问题，未假称全部解决。
- 同一合成故事在原百炼端点对照`qwen-audio-3.0-asr-flash-streaming`与`paraformer-realtime-v2`，仅实验参数切换，未保存到正式设置。Paraformer第一次在空音频预热时返回`NO_VALID_AUDIO_ERROR`，不是余额或鉴权失败；仅访问探测允许这种已启动任务的空输入结束，真实音频错误仍拒绝。

| 试验前缀 | 输入尾音→正式首声 | 短回应 / 识别结果 | 结论 |
| --- | --- | --- | --- |
| overlap-baseline-story-1 | 2.67秒 | 两声均未收到完整回执，第二声实际只有50ms；末词到最终ASR前几毫秒才齐 | 证明旧版仍有短回应截断和时延波动 |
| overlap-concurrent-story-1 | 3.45秒 | 2/2短声完整；完整末句准备只领先最终转写约213ms | 并行修复没有单独证明提速 |
| overlap-qwen-asr-story-1 | 2.23秒 | 1/1短声完整；最终转写仍在输入尾音后约1.02秒，首项模型仅524ms | 不能将这次更快归因于ASR替换 |
| overlap-paraformer-story-1 | 无音频验收 | 空输入探测被拒，未进入播放 | 保留失败，不记入速度 |
| overlap-paraformer-story-2 | 3.67秒 | 1/2短声完整；尾词收尾1.62秒，“旷工”误为“矿工” | 未采用 |
| overlap-final-story-1 | 2.98秒 | 原Fun-ASR，2/2短声完整；最终转写1.23秒，首项726ms，TTS首包1048ms | 未达两秒 |
| overlap-final-story-2 | 14.14秒 | 相同代码，2/2短声完整；末段finish后11.48秒才收到最终识别；录制截止时只确认正式回答前16字播完 | 慢样本保留，不能称稳定提速或完整播完 |

还单独用原故事末尾6秒有效音频及320ms尾静音按实时速度发送，比较Qwen3的Manual协议：Fun-ASR提交后696ms完成，`qwen3-asr-flash-realtime`为741ms，后者最终把“小鲸鱼”写成“小金鱼”。此项是**真实云端ASR诊断，不是整条聊天或中途接话验收**；没有接入生产或重复挑选最好样本。记录`data/overlap-qwen3-asr-diagnostic.json`，可重跑脚本`data/probe-qwen3-asr.mjs`。

学习来源：[百炼实时识别及兼容模型](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)、[Fun-ASR参数](https://help.aliyun.com/zh/model-studio/fun-asr-client-events)、[Qwen3客户端Manual提交](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events)、[已确认前缀与待修订后缀](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events)。文档功能和产品宣传不是本机延迟证据；这几组真实结果不支持现在更换正式ASR，也未测试所有模型或地区。

到这一阶段，原型`npm run check`及489项Node测试通过，日志`data/overlap-check.log`、`data/overlap-tests.log`；前端、桌面产物尚未修改，真实浏览器使用上一轮固定网页`data/two-second-release-web`。后续重复与附和/接管回归结果补在下方。

第二遍出现14.14秒后，改为优先处理识别收尾长尾：正常识别照常，只在finish后1.5秒仍未结束时，使用一条新连接重放同一段有界PCM，一段最多一次、整个收音池最多一个额外识别任务。重试中间稿不公开；原连接与重试的第一个有效最终结果生效，另一路取消。重试失败仍保留原请求；停止收音取消两路。`asrAttempts`区分是否启动重试，不把它记成正常单请求。该保护主要针对十余秒异常，**不能宣称让日常2～3秒自动降到两秒内**。

493项Node及check已通过，含重试输入一致、仅一次最终结果、原结果先到、重试失败、取消迟到结果、单池额外任务上限；这些是模拟边界测试。日志`data/overlap-hedge-check.log`、`data/overlap-hedge-tests.log`。

重试候选的第一轮实际结果（仍使用旧版前端）：

| 试验前缀 | 实际声音与行为 | 结论 |
| --- | --- | --- |
| overlap-hedge-story-1 | 正式首声2.71秒，3/3短回应完整，55字完整回答播完；首句PCM在最终识别前约190ms已就绪 | 实际实现了准备与识别重叠，但未达两秒 |
| overlap-hedge-backchannel-1 | 首答3.83秒；附和期间33573～33833ms发生260ms暂停；真正接管后最后声能270ms、hold672ms，之后无复播 | **附和失败，不部署此候选**；末声早于hold，不能把270ms写成控制器制动速度 |
| overlap-hedge-resume-1 | 首答3.40秒；继续讲话后最后声能410ms、hold612ms，无复播 | 本样本让话正常；不代表主观自然度或真人验收 |

故事末段在finish后2192ms结束，确实启动了第二条识别，但**原任务先完成**。因此2.71秒不能归因为重试抢赢，更不能把14.14→2.71写成同一异常已被消除。该保护的真实获胜收益尚待观察。

附和失败来自实时中间稿先后为“文字”“文字对”“嗯，对对对”：在最终修正前，旧版对没有逗号的短稿按不明语音暂停。补充现有一次400ms识别修正窗口：只有2～3个字且末尾为已知附和片段的初始非最终稿可用，负向/叫停字不适用；修订不续期、已准许的附和续讲不适用、最终稿不适用。没有把“文字对”作为附和白名单，也没有修改640ms/1800ms常规阈值。原轨迹回归先失败再通过，`data/overlap-floor-repro.log`、`data/overlap-floor-unit.log`；494项Node/check及12项相关Vitest通过。前后端共享源码已由`patch-media.mjs`重放，接下来使用新固定网页`overlap-floor-release-web`复测原三音频。

新前端的首遍附和样本`overlap-floor-backchannel-1`仍失败，必须保留：第一句从请求到首PCM用了4.12秒；首播放请求到达时主播已在附和，但当时ASR还没有给出可准许的附和文字，开始回执被拒，前端随后报告播放错误并取消第一答。与`Scheduler.playbackEvent`中“主播仍说话且无准许则拒绝开始”相符；不能把它归为已确认的云端TTS错误，也不能因为没有hold就算附和成功。随后第二答才有声，实际未覆盖原附和窗口。**迟到首声与附和开始相撞的恢复机制仍待改进**，本轮没有通过取消该开始门禁解决。

同代码第二遍`overlap-floor-backchannel-2`：首答2.84秒；31420～35160ms附和期间有实际连续语音、没有hold/yield，中间稿再次出现“文字对”。真正接管40600ms，hold41280ms，最后声能41360ms，即760ms停声，之后无复播。仅证明这次有效样本通过，前一遍播放失败仍计入本轮可靠性问题。

### 最新候选的真实音频复测

以下均使用同一份固定网页`overlap-floor-release-web`、原Fun-ASR/DeepSeek/Qwen与原音频哈希。输入与输出时刻来自浏览器PCM，云端步骤来自本机收发时间；不是物理扬声器延迟，也没有冒充真人或主观试听。六份记录（故事两遍、附和两遍、resume两遍）源码哈希均匹配，正式会话未修改；模型已记录响应均HTTP200，见`data/overlap-final-evidence.jsonl`。

| 试验前缀 | 停口到首声 | 完整性与让话 |
| --- | --- | --- |
| overlap-floor-story-1 | 2.59秒 | 2/2短回应完整，39字正式回答完整播完；两声分别在微停顿后300/340ms起音、续讲前结束 |
| overlap-floor-story-2 | 3.26秒 | 2/2短回应完整，47字正式回答完整播完；两声分别在微停顿后360/300ms起音、续讲前结束；保留1条浏览器409控制台记录，未进一步确定该条请求来源，不能称全程零错误 |
| overlap-floor-backchannel-2 | 2.84秒 | 3.74秒附和无暂停；实际声音重叠时接管760ms停声，无复播 |
| overlap-floor-resume-1 | 2.56秒 | 续讲后661ms hold、2486ms stopped，无复播；上一句在续讲前420ms已经自然结束，**不计作实声制动速度验收** |
| overlap-floor-resume-2 | 2.30秒 | 30530ms继续讲话；第二句在30900ms起音、31184ms hold、31270ms末声，740ms停声且无复播；此次覆盖双方真实语音重叠 |

最终故事等待分解：第一遍转写可用1.296秒、首项模型703ms、首PCM731ms、首PCM至实际首声116ms，提前准备领先转写256ms；第二遍分别1.569秒、1092ms、676ms、116ms，提前准备只领先194ms。转写约占总等待50%/48%；仍是最大的单段，首项模型与TTS合计也约1.43/1.77秒，不能只归因于ASR。相较本轮基线2.67秒，最终2.59/3.26秒**没有证明稳定提速，也未达到两秒**。短声4/4完整仅是这两遍的结果，不能抹去基线截断和其他候选失败。

录音仅裁掉外侧空白，保留双声道及内部时间：

- [最新故事第1遍](../data/listening-audio-trial/overlap-floor-story-1-listen.wav)。
- [最新故事第2遍](../data/listening-audio-trial/overlap-floor-story-2-listen.wav)。
- [最新有效附和/接管](../data/listening-audio-trial/overlap-floor-backchannel-2-listen.wav)。
- [最新继续讲话第1遍（句间停顿）](../data/listening-audio-trial/overlap-floor-resume-1-listen.wav)。
- [最新继续讲话第2遍（实际声音重叠）](../data/listening-audio-trial/overlap-floor-resume-2-listen.wav)。
- [保留的首句迟到/播放失败样本](../data/listening-audio-trial/overlap-floor-backchannel-1-listen.wav)。

### 当前判断与后续方向

这轮没有证据宣布稳定提速：最终故事2.59/3.26秒与本轮旧版2.67秒有重叠，样本量也不足以估计P95。落地的价值是消除已确认的短回应判断阻塞、统一首段起音、增加有界识别长尾保护，以及修复一次实际ASR中间稿导致的附和误停。重试还没有在真实云端样本中抢赢原任务，不能宣称十几秒长尾已消失；首句TTS偶发4秒以上及其撞上附和时失败的路径仍存在。

已经学习并实测不同ASR，不再把反复缩静音阈值当成两秒目标的主线。下一轮应先解决迟到首声与附和相撞时的等待/恢复，再旁路比较更早获得有效首句的路线：音频理解预生成，或缩减首句模型输入与职责，后续解释沿用完整导演；它们尚未接入，必须证明角色、声音和让话行为没有退步。原Qwen无指令克隆音色、DeepSeek正式导演保持；不能仅因一个更快样本切换正式服务。

本轮最终代码检查：根级check/494项Node、4文件12项Vitest、AIRI根类型55/55通过，lint0错误/685警告。对应日志`data/overlap-floor-check.log`、`overlap-floor-tests.log`、`overlap-floor-vitest.log`、`overlap-floor-typecheck.log`、`overlap-floor-lint.log`。新固定网页及桌面均构建通过，见`data/overlap-floor-release-web-build.log`、`data/overlap-desktop-build.log`；真实回归期间未同时跑构建/检查负载。

### 本机更新与保留项

空闲、关麦、主持off时完成备份和重启：后端282144→305040，新桌面`20261019T132401525Z-b9894387`，前版`20261019T120419351Z-0ccd6e92`保留。5174健康接口及实际Electron进程298012（启动器307996）确认新版本在运行；当前live=false、capture=false、stage=1。没有自动开启麦克风或主持。

备份`data/session-backups/overlap-1792416345320.sqlite`，重启后300条聊天按恢复规则逐字段一致，角色/手册/声音/服务/.env指纹全部一致；桌面指针与构建预期一致。见`data/overlap-deployment-before.json`、`data/overlap-deployment.json`、`data/overlap-desktop-expected.json`、`data/overlap-running-desktop.json`。打包后又核对四份有效回归源码哈希，无变化。桌面启动日志含11个closed监听器的`MaxListenersExceededWarning`，本轮未修该警告，启动/状态连接正常；不以此宣称真人Electron语音验收。

未提交、推送、重置其他改动或覆盖密钥。稳定两秒、真实长聊误停率、迟到首声恢复、物理外放回声与主观自然度仍未完成。

### 用户补充与下一轮方案（尚未实施）

用户随后澄清：特指截图中“小鲸鱼”被写成“小金鱼”这样的同音错字，DeepSeek能结合上下文理解，此类错字不应作为否决ASR方案的理由。此前把这条意见扩展为更宽的中间稿/发言确认容错偏好，属于代理理解过宽，已纠正；用户没有因此要求忽略未说完的内容或放宽开口确认。那次Fun-ASR/Qwen3末句诊断为696/741ms，单次均约0.7秒，未显示明确速度优势，也不足以判定两者长期优劣。

代码复核：`AnswerPreparation.matches`仅忽略末尾标点/空白，其余文字变化会使草稿取消；普通完整回答仍要求最终转写与话轮结束。当前默认只启用分段结束准备，较早的完整草稿仍关闭。最新两遍准备仅领先最终转写256/194ms，故“已有提前准备”不代表有效覆盖了模型/TTS等待。

实施顺序调整为：

1. 先在稳定、已成义的中间转写上准备一条短首句和相应PCM，明确分开内容可理解与当前可开口；支持边讲边算，限制尝试次数，继续讲话不自动丢掉仍相关的准备。不直接重开此前失败的整篇预生成。
2. 对可以确定不影响首句的转写小修保留准备，先覆盖标点等清晰类别；不能仅凭字符相似度放过否定、对象和请求变化。首轮保留现有开口确认，先验证准备能否更早完成。非final播放是另一项尚未选择的技术试验，不由用户接受同音错字推导出来；不要新增一个串行大模型校对请求抵消收益。
3. 缩减普通闲聊首句请求中与本轮无关的功能说明，保留人设、关键记忆与当前对话，并对照角色/控制指令质量；同一DeepSeek与原克隆声音优先。现有首句长度、动作后置和缓存已经存在，不当成新优化。DeepSeek缓存命中也不能消除生成/TTS等待，见[官方缓存说明](https://api-docs.deepseek.com/guides/kv_cache/)。
4. 修复迟到首句撞附和时立即播放失败：有限保留待播首句，附和确认后恢复，真正接管仍丢弃；不放宽既有接管停声规则。

研究依据：[LiveKit话轮调优](https://docs.livekit.io/agents/logic/turns/tuning/)将发言时机、打断与提前生成分别处理，支持提前TTS并要求取消过期结果；它不保证本机延迟，也不直接提供本项目所需的转写容错策略。上述稳定中间稿准备是本项目待验证设计，尚不改变正式播放许可。

收益目标是让停口后的1.4～1.8秒模型/TTS工作尽量在讲话期间完成，而非直接把ASR耗时从总延迟中减掉。先验收准备提前量、有效复用率与有内容首声的等待分布，同时保留原三音频的附和不停/接管停止/短回应完整指标。新策略的两秒收益尚无实测；本次仅记录偏好与方案，没有修改运行逻辑或重复测试。

对用户询问的量化预期：以现有两遍停口到最终转写1.30/1.57秒为基础，若有效首句文字与PCM能在最终转写前就绪，正常准备命中场景的工程目标约1.5～2秒起声；若准备未命中、仍需串行生成，预计仍可能约2.5～3.5秒，云端异常可更长。这些是有条件的预算估计，不是已测分布，也不是稳定两秒或一秒以内的承诺。当前真实结果仍为2.59/3.26秒。

### 当前版本逐段耗时与其他候选方案

应用户要求，读取同一最终版本的`overlap-floor-story-1/2-latency.json`与原记录，未重新运行试验。从输入最后声能到输出首声计时；实际声卡输入缓冲、物理扬声器延迟没有测量。讲话时每32ms音频帧持续上传，这个分片周期不等于麦克风端到端延迟，也不在停口后再叠加整段录音时长。

| 过程 | 第1遍耗时 | 第2遍耗时 |
| --- | ---: | ---: |
| 停口→本地完成分段并发送finish | 0.279秒 | 0.306秒 |
| finish→最终转写可用（含网络/服务收尾） | 1.017秒 | 1.263秒 |
| DeepSeek请求→首句可用，含接话判断 | 0.703秒 | 1.092秒 |
| 首句就绪→启动提前语音合成 | 0.000秒 | 0.001秒 |
| Qwen合成请求→首批原始PCM | 0.731秒 | 0.676秒 |
| 首PCM→播放器排播 | 0.019秒 | 0.023秒 |
| 排播→输出出现首个声音 | 0.097秒 | 0.093秒 |
| 以上识别与DeepSeek已重叠，应扣除 | −0.256秒 | −0.194秒 |
| 实际总等待 | **2.590秒** | **3.260秒** |

第一遍DeepSeek在停口后1.040秒开始、1.743秒产出首句，Qwen到2.474秒返回首PCM，2.590秒出声；最终转写在1.296秒可用，因此两阶段交叠256ms。第二遍对应1.375→2.467→3.144→3.260秒，最终转写1.569秒可用，交叠194ms。正式台词进入播放管线的少量交接在提前合成期间发生，不能再把它重复加入总耗时。

DeepSeek请求首token分别525/858ms，首token至首条记录178/234ms；输入9547/9590 tokens，缓存命中均9088。请求到首token仍混合传输、服务排队和计算，无法凭这些日志独立归因于云端某一步。当前已经有缓存，不能把“加缓存”写成未做过的新提速。

除了提前准备，还可分别比较：普通闲聊首句请求精简、不同首字延迟的模型；本地中文流式ASR，避开云端识别往返但需实测本机推理；更低首包延迟的TTS，先验声音；原生音频输入/输出模型，改变三段服务串联的架构。以上均未新增接入，不能承诺各自节省秒数。保留DeepSeek与当前音色时，先实现讲话期间的有效首句准备，再做首句请求精简与本地流式ASR对照；原生音频模型适合作为独立性能/角色/声音参照。

来源：[sherpa-onnx官方中文流式模型](https://github.com/k2-fsa/sherpa-onnx#some-pre-trained-asr-models-streaming)、[Qwen-Omni实时音频输入输出](https://help.aliyun.com/zh/model-studio/realtime)、[Omni音色与目标模型匹配要求](https://help.aliyun.com/zh/model-studio/qwen-omni-voice-cloning)。原生音频方案需重评DeepSeek的角色以及音色匹配，不假定当前Qwen TTS克隆ID可直接复用。纯粹提前播缓存附和可改善冷场感，但不算有内容回答的延迟降低。

### 提前听前文与早期本地识别的核对

用户进一步指出，应在讲话过程中把前面几句话交给DeepSeek理解、准备，停口后接上。此方向与前述短首句准备一致；当前流式中间文字虽已用于倾听/短回应，正式回答准备仍主要发生在分段结束，最新两遍到停口后1.040/1.375秒才启动。继续讲话或转写变化会清理准备，不能把这称为已完成讲话期间的充分并行。[代码](../apps/cohost/participation.mjs)；[合并前段与当前转写](../apps/cohost/airi-voice.mjs)。LiveKit的默认提前生成以分段最终转写到达、整个话轮尚未确认结束为起点；本项目基于稳定中间稿的准备还需自行实现，不能仅调静音阈值或打开旧整篇草稿开关替代。

早期真正本地的方案是Windows System.Speech：识别器静音结束阈值650ms、歧义静音1000ms；中间文字仅展示，最终文字才进入导演；回复整段生成后才朗读。该结构可解释部分等待，但没有同条件逐段计时证明当时主要慢在识别器计算。[原生识别器](../apps/cohost/windows-speech.cs)、[桥接](../apps/cohost/windows-voice.mjs)、[2026-10-11记录](STATUS-HISTORY-2026-10-14.md)。历史SenseVoiceSmall单次10.52秒是硅基流动云端整段识别请求，不是本地推理成绩，亦非平均耗时。

更适合比较的本地候选是sherpa-onnx的中文[在线Zipformer](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html)与[在线Paraformer](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-paraformer/index.html)，它们支持实时麦克风与中间结果。尚未在本机下载、接入或测量，不能称为已找到更快替代。将来应以原音频按实时速度输入，对比稳定中间稿到达、停口收尾、CPU占用及完整接话表现；先做结构并行，不因“本地”二字预设必然更快。本次仅核对代码/历史与官方资料、更新方案，没有修改运行代码或启动复测。
