# 文档入口：按当前任务阅读

默认只读 [STATUS](STATUS.md)；需要细节时，从下表选一个入口，再搜索相关标题。
当前规则在 [AGENTS](../AGENTS.md)。同一主题优先更新已有文档，避免再建一份重复说明。

| 要解决的问题 | 先读 |
| --- | --- |
| 当前部署、已知问题、下一步 | [STATUS](STATUS.md) |
| 保存版本、找旧版、恢复范围 | [版本与存档](VERSIONS.md) |
| 启动、更新、桌面回退 | [固定桌面](DESKTOP-BUILD.md)；环境问题查 [本地开发](LOCAL-DEVELOPMENT.md) |
| 角色卡、声音和配置保存 | [配置仓库](RUNTIME-SETTINGS.md) |
| 聊天、摘要和数据库恢复 | [场次记忆](SESSION-MEMORY.md) |
| 接话延迟、识别、本地 ASR 试用 | [本地识别试用](LOCAL-ASR-TRIAL-2026-10-20.md)；按引用追查上一轮 |
| 自主主持和时间感知 | [持续观察](DIRECTOR-OBSERVATION-2026-10-20.md) |
| 导演反馈、手册、查询资料 | [原生手册](DIRECTOR-HANDBOOK.md)、[MCP](DIRECTOR-MCP.md) |
| Live2D 表情、动作、尾巴 | [表演能力](PERFORMANCE-CAPABILITIES.md)、[尾巴](TAIL-ELASTICITY-2026-10-20.md) |
| B 站弹幕接入和验收 | [B 站](BILIBILI.md) |
| 改架构或 AIRI 源码 | [架构验收](ARCHITECTURE-ACCEPTANCE.md)、[集成说明](../integrations/airi/README.md)、[AIRI 检查](AIRI-CHECKS.md) |
| 原始需求或云端工作 | [原始交接](HANDOFF.md)、[云端](CLOUD.md)，仅在相关任务中阅读 |

日期报告保存当时的测试、失败样本和部署证据；其中的旧 PID、构建号、参数不直接代表当前状态。
旧架构设计也要先核对 STATUS 和专题的最新结论。源码、所选桌面产物、实际运行进程可能处于不同版本。

2026-10-20 精简前的完整交接保存在 [历史快照](STATUS-HISTORY-2026-10-20.md)，其中继续链接更早记录。
历史文件保持可检索，默认不展开；无需为回答进度问题重新跑测试。
