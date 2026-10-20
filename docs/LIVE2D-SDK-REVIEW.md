# Live2D AI 演出方案对照

核对：2026-10-12。用户提供 nanlingyin/soullink-emotion-sdk。调研固定 SDK 提交 `02cd75ac0a085a87d84d1a885f1b33eca8742d53`；公开文本保存在忽略的 data/soullink-research。未执行第三方源码、安装 SDK 或修改正在运行的 AIRI。其他方案仅核对官方说明，未声称经过相同程度源码审查。

## SoulLink 的实际价值

- VAD 指 Valence/Arousal/Dominance 情绪三轴，并非语音活动检测。FACS/AU 提供通用面部动作语义，Profile 映射到角色实际参数；不会为没有绑定的模型创造肢体或变形。
- 分开组织情绪、Idle、反应、语音动作和 LipSync。本地 TypeScript engine 可脱离 LLM、Embedding 和语音供应商使用。自然待机的变化、防重复和连续状态，比单次切 exp3 更贴近本项目的表演自然度需求。
- 可选 JEV/说话动作 Planner 输入 CDI/Core 参数名称、范围、默认值与台词，输出稀疏绝对目标关键帧。实际参数 Planner 有真实 ID、有限数值、范围约束及嘴部开合排除；关键帧由本地 sequencer 插值，模型不逐帧推理。“JEV”接口名称不能证明包含专门训练的动作模型权重，本次所读实现调用 OpenAI-compatible 模型。
- 模型适配以标准 Cubism ID、CDI 名称和声明式覆盖为基础，有可选 LLM 精修与校准工具。参数 ID 验证不等于视觉组合正确；私有参数和互斥图层仍要逐项预览。
- renderer 有原生表情参数抑制集合，避免程序参数与 exp3 抢同一参数。PIXI 渲染包限定 v7；与 AIRI 集成时先评估纯 engine/协议适配，不直接更换其渲染器或建立第二个舞台。

## 需要避免直接照搬的行为

1. `SoullinkSpeakingMotionPlanner` 默认 `twoStage: true`：先请求语义动作，再请求参数帧；格式失败还可能尝试其他格式。`createSoullinkSession` 的 fixed-parallel 路径使用 `await Promise.all([ttsTask, parallelMotionTask])` 后才播放。并行降低串行总耗时，却不能保证动作规划不拖慢首声。小鲸鱼继续优先复用同次 DeepSeek 输出，不默认新增这两轮动作推理；可选异步计划必须有超时、取消与迟到保护。
2. `ParameterPlanSequencer` 缺失的前后值用 0 插值；`LayeredParameterMixer` 未提供目标也回 0。模型中立值可能不是 0，不能不加适配就恢复鲸鱼娘所有原始参数。
3. 通用逐帧平滑也可能用于离散图层。鲸鱼娘笑眼替换开关此前在中间数值出现两套眼睛，必须继续按族互斥、完整开关，不把所有参数统一缓动。原生表达式参数抑制与互斥图层是不同层面的问题。
4. 消息情绪分类可用规则或 Embedding，但主播生气不代表小鲸鱼应该同步生气。自己的反应由导演/角色语义决定，不能把每条输入直接当自己的情绪。

## 其他公开路线

| 路线 | 官方可核实能力 | 对本项目的意义 |
| --- | --- | --- |
| Open-LLM-VTuber | 后端情绪映射到 Live2D 表情，语音交互与桌面/Web 客户端 | 对照通用聊天流程，未由 README 证明任意组件自主动作 |
| VTube Studio Public API | 获取与注入跟踪输入参数，表情和热键接口；注入值通过模型映射生效 | 若将来切换 VTS 舞台可作为输出接口；API 本身没有情绪判断或动作编排 |
| Amadeus | 句子绑定表情、实际播放同步、句尾交接；主体演示使用 SpriteForge，另有 Live2D 路径 | 参考演出时钟和正常结束/打断语义，见 docs/AMADEUS-REVIEW.md |
| SoulLink SDK | 连续情绪、分层本地执行、Profile 与可选参数关键帧 Planner | 本轮最贴近演出改进需求的候选，但尚未在鲸鱼娘模型视觉验收 |

MCP 只是让 AI 调用动作接口的方式；动画质量主要取决于模型能力、动作计划、时序、参数混合和校准，不由 MCP 名称保证。

## 建议试验顺序（尚未开发）

保留 AIRI 舞台、直播导演、现有 44 项原生项目和归一化自主组件。先用隔离的演出对照评估本地情绪连续性、待机微动与说话重音，保证一次只由一个执行器控制各参数。随后按句/音频阶段绑定已有 AI 动作，声音与面部共享情绪。确实需要更自由的动作时，再开放已测量、描述清楚的参数能力，不直接暴露所有原始参数。

对照同样的平静倾听、被夸、嘴硬转轻笑、摇尾、长句和打断场景：观察自然度、重复、抢口型、叠眼、恢复默认与人工设置保留，并记录首声是否变慢。源码中的测试和演示不代替本项目实际渲染验收。

## 来源

- [SoulLink SDK](https://github.com/nanlingyin/soullink-emotion-sdk)
- [集成与 JEV 参数规划说明](https://github.com/nanlingyin/soullink-emotion-sdk/blob/02cd75ac0a085a87d84d1a885f1b33eca8742d53/docs/integration-tutorial.md)
- [说话动作 Planner](https://github.com/nanlingyin/soullink-emotion-sdk/blob/02cd75ac0a085a87d84d1a885f1b33eca8742d53/packages/planner-openai/src/SoullinkSpeakingMotionPlanner.ts)
- [会话编排](https://github.com/nanlingyin/soullink-emotion-sdk/blob/02cd75ac0a085a87d84d1a885f1b33eca8742d53/packages/runtime-core/src/createSoullinkSession.ts)
- [关键帧插值](https://github.com/nanlingyin/soullink-emotion-sdk/blob/02cd75ac0a085a87d84d1a885f1b33eca8742d53/packages/engine/src/reaction/ParameterPlanSequencer.ts)
- [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)
- [VTube Studio 官方 API](https://github.com/DenchiSoft/VTubeStudio)
