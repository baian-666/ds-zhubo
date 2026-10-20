# 导演持续观察时间，自主选择开口

2026-10-20。用户明确要求不按定点唤醒安排发言。此前[时间修复](HOSTING-CLOCK-2026-10-20.md)的持续模式计时复查已被本方案替换。

## 当前机制

持续主持启用后，后台串行运行简短观察。每次提供当前时间、实际安静/留白耗时、最近已交付内容、角色和上次公开选择。观察只有 `wait`、`consider_speaking` 两种结果，不生成台词或控制工具。后者必须有具体内容方向，完整导演随后仍可选择等待。

API模型在请求之间不运行。这里的持续感知是反复收到最新现场与时间，不是无限持续推理。请求最多每秒开始一次，上一请求未结束不再发起。此限速控制资源，不决定发言间隔。模型响应和负载会拉长观察间隔，持续主持会增加模型调用量。

持续主持不设置 `nextReviewAt`、静默30秒接播或1～10秒续讲时间。`closing`只表示实际交棒给观众、搭档或仍想继续，不含时间预约。可以一直安静，重复观察不清零真实安静时长。未开启、人工暂停/停止、静音、舞台离线不运行观察。模型等待与人工暂停分开。

人类输入和真实播放沿用现有优先级。新输入、版本变化或停止使旧观察失效。观察与正式判断共用取消和任务范围，不并发堆积。不逐次写等待气泡或数据库记录，仅保留最近公开选择和计数。30/60/120秒只用于连接失败后的退避，第四次失败暂停，不是发言预约。

有限轮次模式仍支持原有显式预约，用于受限运行及回归测试。正式桌面默认持续模式。手册和中文/英文提示继续内嵌原生桌面设置，没有新增网页。

## 验证及限制

- `npm run check`、`npm test`：530项Node测试通过。模拟一分钟61次连续选择等待，无台词、无定时截止、无等待记录刷屏。也覆盖“观察想说，完整导演仍等待”、串行请求和人工控制撤销。
- 实际HTTP服务器在无人发送新消息时取得多次不断更新的墙钟观察。模型边界使用替身，没有ASR/TTS。与模拟时间测试分开。
- 最终源码、真实DeepSeek、合成现场及模拟经过时间：`data/director-observation-trial-1792498871022/report.json`，6/6时间与状态选择符合预期。刚交棒3秒和18秒等待；47/91秒考虑内容；同话题续讲8秒也可考虑；人工暂停180秒仍等待。这些不是硬编码时间边界，也不证明长播自然度。前轮18秒曾选择考虑，保留 `data/director-observation-trial-1792498710956/report.json`。
- 同轮真实完整台词仍出现未标明假设的个人亲历。暂停理由还混用了“静音”，尽管动作正确。观察提示已要求区分来源和状态，仍有语义错误。因此6/6仅指时间/状态选择，不是内容质量全通过。没有真人语音或主观自然度验收。
- 保留首轮全等待偏保守样本 `data/director-observation-trial-1792498391882/report.json`。第二轮 `data/director-observation-trial-1792498482768/report.json` 暴露 `active=false` 被误认为停播、空意图与虚构亲历。最终输入改用 `audioPlaying`，并拒绝空的开口意图。无自动重试或删除失败样本。

`node scripts/check-airi.mjs typecheck`：55/55通过。`node scripts/check-airi.mjs lint`：0错误、689警告。`node scripts/desktop.mjs build`成功，正式桌面 `20261020T121921713Z-1ac6e5fb`。

## 部署

沿用用户“现在更新，允许中断当前对话”的授权。通过既有停止接口安静现场并备份，后端330968→339336，正式桌面已重新启动加载本轮构建。最新300条聊天按RoomJournal恢复规则逐字段一致，角色、声音、服务、手册及.env指纹保留。备份 `data/session-backups/continuous-observation-1792498888538.sqlite`，核验 `data/continuous-observation-deployment.json`。

现有 `node scripts/desktop-smoke.mjs`通过：原生导演手册/MCP、克隆音色配置、画布、重复启动复用、页面错误0，没有iframe。未启动收音或发测试聊天。证据 `data/continuous-observation-native-smoke.log`、`data/continuous-observation-running.json`。更新后主持off、关麦，需要搭档重新开始收音并授权继续主持。

## 源码与复现

[观察请求](../apps/cohost/director-observation.mjs)、[主持状态机](../apps/cohost/hosting.mjs)、[判断生命周期](../apps/cohost/participation.mjs)、[导演说明](../apps/cohost/participation-model.mjs)、[收尾](../apps/cohost/hosting-closing.mjs)、[原生手册](../apps/cohost/director-manual.md)、[回归](../tests/director-observation.test.mjs)、[真实隔离试验](../scripts/director-observation-trial.mjs)。

真实试验需要显式 `--real` 和已有本机模型凭据。只读模型选择，不写正式聊天，不播放声音。
