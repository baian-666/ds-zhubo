# 在 Codex Cloud 接续开发

目标仓库：https://github.com/baian-666/ds-zhubo ，分支 `main`。

## 当前准备范围

仓库保存代码草稿、需求、技术方案、验证记录和后续计划。文档不代表环境已经创建或发布。实际环境状态以 Codex Cloud 界面为准。

之前创建的 ChatGPT Work 云端对话用于保留讨论上下文，与 Codex 的对话历史和运行环境分开。GitHub Codespaces 是另一种开发环境，也不等于 Codex Cloud。

## 创建环境

1. 在 Codex 界面新建任务，选择 `Work in → Cloud → Select environment → Create environment`；也可从设置中的 `Codex Cloud → Environments` 进入。
2. 选择 `baian-666/ds-zhubo`，让环境检出 `main`。
3. 使用下面的环境要求，让 Codex 完成准备与测试。
4. 查看准备报告并保存。通过后选择 `Publish`，等待显示 `Environment published`。
5. 在这个环境里开始任务。另一台设备登录相同账号和工作区，继续打开同一个云端任务。

如果仓库不可选，需要检查本账号和工作区的 GitHub 连接及仓库授权。GitHub 连接器能写仓库，不自动证明 Codex Cloud 环境已经获得仓库权限。

来源：[官方云端环境文档](https://learn.chatgpt.com/docs/environments/cloud-environments)。

## 环境要求

- 检出本仓库，先只验证 `apps/cohost` 原型。
- 使用 Node.js 26.7.0。根项目仅用内置模块，没有需要安装的 npm 依赖。
- 运行 `npm run check` 和 `npm test`。无需 API Key，不进行真实模型调用。
- 若继续 AIRI 安装，使用 pnpm 11.24.0。版本来自 `airi.lock.json` 固定的上游工具配置。
- AIRI 的完整安装另行执行 `npm run setup:airi`，依赖及模型资源下载需要网络。不要把未执行的安装或渲染写成已验证。
- 不复制原电脑 `.env`、账号文件或其他凭据。下一阶段需要时，使用环境提供的 secrets 机制配置 DeepSeek 和语音服务。

本项目的开发服务与正式直播服务分开。Codex Cloud 的浏览器、实时麦克风和音频预览能力需按实际环境验证；代码检查通过不等于完成真人语音试播。正式试播仍需要浏览器或直播设备来采集麦克风并播放音频。

## 首条接续消息

```text
继续 ds-zhubo 项目。先读取 AGENTS.md、docs/HANDOFF.md、docs/STATUS.md 和 docs/CLOUD.md。

目标是基于 AIRI + DeepSeek 做中文 Live2D 直播助播：真人主播主导，自然接话、附和、偶尔短插嘴、选择性回弹幕，不做游戏操作。云端开发和 AI 服务，直播设备负责麦克风、Live2D 和推流。

先检查当前代码并运行 npm run check 和 npm test，确认开发环境可以恢复。接着只给出最小语音试播实施方案：识别、TTS、话轮判断、打断、模拟弹幕、人工导演与自动导演对照。明确现有代码哪些能复用、哪些缺失，以及需要的凭据和资源。此阶段不购买资源、不进行正式直播、不声称达到 Neuro 水平。
```

## 换设备前

将代码和 `docs/STATUS.md` 的更新提交、推送到 GitHub。不要将云端任务的临时文件、浏览器缓存或未提交目录当成唯一备份。
