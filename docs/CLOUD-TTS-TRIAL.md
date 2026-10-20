# 云端 TTS 单次试听与延迟对照

**当前（2026-10-18后续回退）：用户实际聊天后要求恢复不带指令的版本，已生效。所有Qwen发声均省略instruction，宵宫克隆不变，emotion能力关闭。下方情绪指令试验与首次上线记录仅为历史。[当前回退证据](VOICE-CONSISTENCY-2026-10-18.md#实际聊天后恢复无指令版当前)。**

日期：2026-10-15～16。下文保留各次实验的条件；最新部署见末节。先听音色，不反复跑付费测速。

## 本次结果

同一句「你来啦！今天有什么好玩的事情，快说给我听听。」，每个引擎各真实合成一次，通过现有 SpeechOutput 适配器和隔离浏览器 PCM 播放队列测量。

| 指标 | Qwen 云端 | 当前 Index 本地 |
| --- | --- | --- |
| 模型/声音 | qwen3-tts-flash-realtime / Vivian | IndexTTS2.5 / 宵宫中文参考 |
| 首音频到浏览器 | 0.821 秒 | 9.515 秒 |
| 软件排定首次播放 | 0.863 秒 | 9.579 秒 |
| 音频长度 | 4.800 秒 | 5.143 秒 |
| PCM 分块 | 15 | 1 |
| 播放队列断档 | 0 | 0 |

Qwen 本次提前建连另用 **5.171 秒**，上表为连接已准备好的请求。若串行等待首次建连，本条从准备到首音频约 5.99 秒；不能把 0.82 秒视为每次冷启动或整个对话的响应时间。现有连接缓存有空闲过期，需要后续验证准备时机与长聊重连。

Index 使用当前已运行服务，contextual 模式下请求 neutral，beams=3、CFM=25；未改音色参数，也未重启模型。短开头与后续正文被现有分句策略合并，本次收到一整块音频。

## 证据与限制

- [原始报告](../data/cloud-tts-trial-2026-10-15T15-41-51-933Z/report.json)、[Qwen 试听](../data/cloud-tts-trial-2026-10-15T15-41-51-933Z/qwen.wav)、[Index 对照](../data/cloud-tts-trial-2026-10-15T15-41-51-933Z/index.wav)。本机 data 为忽略的实验产物。
- 各一次真实生成、相同文字、不同声音；不包含 ASR、导演或 LLM。未采样 GPU 同时负载，不能当成严格硬件极限或稳定分位数基准。
- 浏览器首次播放为 AudioContext 软件排程，未测扬声器实际出声。试听文件已生成，点击播放的等待也不代表合成耗时。
- 音频非静音、无削波，队列未断档；自然度、音色偏好与中文准确度仍待用户听审。
- Qwen 是预设 Vivian，并非宵宫克隆；现有 Qwen 适配器未接自定义克隆或情绪控制。没有上传参考录音。
- 生产仍为 Index；正式配置、角色和 .env 保留，未重启桌面或生产服务。

## 下一步

先确认 Vivian 的声音是否可接受。通过后再验证真实聊天下的首声、冷连接恢复、连续长句和打断，并决定是否使用云端主声音；当前不重复付费测速、不覆盖已有宵宫音色。

## 2026-10-16：同参考音色克隆试听

用户要求 Qwen 也克隆现有音色，已准备隔离脚本 `data/qwen-clone-trial.mjs`，目标模型 `qwen3-tts-vc-realtime-2026-01-15`。使用当前 Index 的宵宫中文 `reference.wav`（12.370 秒、PCM16），只创建一个音色并生成同一句试听；若已保存音色编号则复用，已有试听则拒绝重复生成。不会切换生产声音或改 .env。

官方确认 [该实时模型支持克隆音色](https://help.aliyun.com/en/model-studio/qwen3-tts-vc-realtime)，[创建接口](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)使用 qwen-voice-enrollment；克隆目标型号必须与后续合成匹配。试听脚本暂用隔离的客户端副本，生产适配器和 AIRI 声音目录尚未加入克隆音色。

首次阻挡为连接超时/重置（`UND_ERR_SOCKET`），当时DNS返回代理虚拟地址。用户要求重试后，音色列表查询成功且为空，确认之前没有残留音色；Node上传仍遇ECONNRESET，改用Windows curl成功创建。密钥只经标准输入传入子进程，没有写入脚本、请求文件或命令行。

当前阻挡已经变为服务端模型不可用：分别为官方列出的 `qwen3-tts-vc-realtime-2026-01-15` 与 `qwen3-tts-vc-realtime-2025-11-27` 创建了两个匹配音色，编号各保存在本机 `data/qwen-clone-yoimiya-20261016/voice.json` 与 `data/qwen-clone-yoimiya-20261016-v1127/voice.json`。**两版均在session.update阶段关闭连接，代码1007，原因Model not exist.** 同密钥、同北京入口、同配置字段的预设Vivian能到session.updated；无版本克隆别名也返回Model not found。session.created只表示握手，不证明模型可用，先前仅握手的probe结果不得作可用性证据。[完整配置阶段对照](../data/qwen-clone-yoimiya-20261016/session-probe.json)、[克隆试听失败记录](../data/qwen-clone-yoimiya-20261016-v1127/report.json)。

上述旧型号实验没有成功提交合成文本或生成克隆试听，不提供旧型号克隆质量/速度结论。旧音色保留，不再重复创建；新进展如下。

## 2026-10-16：Qwen-Audio 3.1 克隆接入并部署

用户登录百炼后，核实当前模型目录提供 `qwen-audio-3.1-tts-flash`。该型号使用 `/api-ws/v1/inference` 的 run-task/continue-task/finish-task 协议，与旧 Qwen3 Realtime 不同；仅更换旧客户端的模型字符串无法接入。新适配器见 `scripts/qwen-audio-client.mjs`，保留旧预设音色适配器，按实际型号分派。

- 同一份宵宫中文参考（12.370 秒、PCM16）通过百炼官方临时上传空间上传，再调用 voice-enrollment 创建新型号音色；查询状态为 OK。临时资源与账号/模型绑定，不使用公共文件分享站。声音编号仅在本机忽略的 `data/qwen/voice.json`，API Key 仍只读 `.env`，未复制进 AIRI 供应商页面。
- 新客户端准备阶段必须收到 task-started，再取消空任务并等待 task-finished；准备本身不合成。正式任务输出二进制 PCM；任务结束后复用连接，每次任务 ID 独立。取消/超时关闭连接且丢弃迟到音频，错误消息脱敏，音频大小受限。事务配置失败保留旧声音。
- 单次隔离样本仍为「你来啦！今天有什么好玩的事情，快说给我听听。」：初次准备 3.808 秒；复用连接首 PCM 到服务端 1.931 秒，包含新任务准备约 0.379 秒；音频 3.970 秒、9 块。非静音、无削波。[试听](../data/qwen-audio-yoimiya-20261016/sample.wav)、[原始报告](../data/qwen-audio-yoimiya-20261016/report.json)。未作真人听审，未重复跑速度基准。
- 部署后通过现有 `/api/speech/preview` 在实际桌面播放一条集成试听（不同于上述对照台词），状态 completed；TTS 请求到首 PCM 1.246 秒，到桌面排定播放回执 1.374 秒，capture:false。连接准备在请求 TTS 前完成，不含 ASR/LLM/物理扬声器延迟。[播放回执](../data/qwen-audio-yoimiya-20261016/desktop-preview.json)。这是集成验收，不与旧基准合并计算平均速度。
- 已通过配置事务将正式声音切为 Qwen / 克隆音色，实际型号 qwen-audio-3.1-tts-flash，SQLite 持久化。原 300 条聊天在部署前后核对保留，试听新增气泡按既有 300 条上限滚动；完整部署前备份在 `data/session-backups/qwen-1792114555306.sqlite`。角色、LLM 设置、.env 保留，Index 未重启。后端 PID163560；主桌面因既有播放连接未登记，刷新后恢复并完成试听。[部署记录](../data/qwen-audio-yoimiya-20261016/deployment.json)。
- `npm run check` 与 293 项 Node 测试通过，包含克隆元数据、任务关联、连接复用、取消、错误脱敏与异常 PCM。未改 AIRI 源码或重建桌面，声音列表由后端动态提供。

### 用户设置入口与剩余边界

日常入口是 **AIRI 设置 → 发声 → Qwen 云端 / 预设与克隆 → 克隆音色**，顶部应显示实际型号；可从这里试听，或切回 Index。不要在「服务商 → 阿里百炼」重复填密钥：当前固定 AIRI 的原生供应商页默认 CosyVoice，API Key/音高/语速/音量属于原生链路，尚未映射到助播 Qwen 适配器。截图里的供应商详情页与助播发声页没有完全统一，这是已确认的界面整合缺口，不能宣称全设置已打通。

首次接入时适配器固定默认速度/音高，尚未发送情绪指令；后续情绪接入见下一节。不要把旧 Vivian 的 0.821 秒直接作为此克隆的指标。

官方接口依据：[实时合成与连接复用](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)、[音色复刻](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)、[临时上传空间](https://help.aliyun.com/zh/model-studio/get-temporary-file-url)。

## 2026-10-16：用户听审通过，接入上下文语气

用户确认上一版 Qwen 克隆的音色、中文准确度均无问题，并观察到文字本身已带来一定自然语气。本次保留这种默认表现：neutral/缺省/非法值不发送 instruction，继续由 TTS 根据文字处理。happy、gentle、surprised 分别映射为轻快带笑、温和体谅、轻微意外的固定中文提示，放进 run-task 的 parameters.instruction，保持音色、rate=1、pitch=1，不把控制文字加进正文或字幕。映射位于 `scripts/qwen-audio-style.mjs`，协议依据为[官方客户端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-client-events)。

沿用现有话轮 speechStyle：自动导演从原 decision 中选择，人工回复使用原隐藏前缀；一轮固定，下一轮重新选择，无额外情绪 LLM、网络步骤或音频后处理。提示每个任务重新构造，连接复用不保留上轮语气。只有实际使用新 Qwen-Audio 克隆时，配置快照 emotion:true；旧预设声音仍 false。AIRI「发声」页读取该能力，不需重建桌面。供应商详情页的独立滑块仍未映射，不能据此认为已经全部统一。

验证：

- `npm run check` 和 295 项 Node 测试通过。新增验证开心→安慰→惊讶→普通/非法值在同一连接上的隔离、正文不变、无额外请求、队列语气归属与能力报告；既有取消、迟到音频、服务器话轮授权测试保持通过。
- 开心、安慰、惊讶各真实合成一条（未重复测速），全部完整非静音、无削波；首 PCM 分别约1.154/1.085/1.045秒，台词不同且连接已准备，不能用来比较情绪速度。[报告](../data/qwen-emotion-20261016/trial.json)、[开心](../data/qwen-emotion-20261016/happy.wav)、[安慰](../data/qwen-emotion-20261016/gentle.wav)、[轻惊讶](../data/qwen-emotion-20261016/surprised.wav)。接口成功不能证明情绪强度已听审通过。
- 部署后做一轮真实 DeepSeek→Qwen→桌面测试，模型选gentle，回复「行，这次不怼你——累了就歇会儿，我在。」；completed、capture:false。执行到桌面排定首声3.044秒，TTS到首PCM1.293秒、到排定播放1.454秒。不含麦克风/ASR或物理扬声器测量；单次结果，不能保证任何网络条件下都无延迟增量。[完整对话回执](../data/qwen-emotion-20261016/conversation.json)。
- 后端PID145324加载新适配器；配置修订号与音色、人设、.env及部署前300条聊天核对一致。备份`data/session-backups/qwen-emotion-1792115878334.sqlite`，测试新增聊天按既有窗口滚动。Index未重启；桌面主窗再次需要刷新才能恢复播放登记，已恢复并完成测试，重连问题需单独定位，不能视为已修复。[部署核验](../data/qwen-emotion-20261016/deployment.json)。

以上为10月16日初始接入记录，neutral不发送instruction的行为已由下述10月18日版本替代。暂不做逐字/句内情绪曲线、随意变音高或多层情绪模型。

## 2026-10-18：统一自然表达，日常与开心已听审启用

用户听出开心指令会改变声音质感，认为其更自然，随后通过「统一自然基础＋日常平和」和「同一基础＋完整原happy指令」两版，授权正式启用。所有Qwen发声预设现都带`保持原音色，自然口语表达，停顿和重音随语意，语速适中。`，neutral再加`语气平和。`；happy维持用户认可的原开心程度，gentle/surprised增加同一基础但保留原情绪描述。缺失/非法语气回自然neutral；无声连接预热除外。

导演按语境在原模型调用内选择预设，明确neutral同样自然，不用happy代替日常自然表达；一轮内语气由后端固定，播放端不能覆盖。Qwen发声seed0、音色ID/rate/pitch保持试听条件。check/440项Node测试通过，真实试听已获用户认可；仅重启空闲后端，保留300聊天及全部持久设置、角色、克隆和.env。请求参数一致不等于云端声纹绝对稳定，继续观察真人长聊。[试听、实现和部署证据](VOICE-CONSISTENCY-2026-10-18.md#用户通过并正式启用)。
