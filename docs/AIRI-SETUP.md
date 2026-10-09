# AIRI 舞台安装与接入记录

更新：2026-10-09。本文记录实际执行结果；安装成功不代表形象、语音或虚拟直播间已经验收。

## 本轮结果

- 固定版本：`airi.lock.json` 中的 `34576c19f618a04e616657089f0688a8637873f2`，检出到忽略目录 `vendor/airi`，没有修改上游受跟踪文件。
- 工具链：Node 26.7.0、npm 11.19.0、pnpm 11.24.0。
- 完成 stage-web 及其工作区依赖的锁文件安装，安装时跳过生命周期脚本；随后单独执行所需工作区包的 build，退出码 0。没有执行完整桌面版安装、原生依赖验收或上游全量测试。
- 第一次启动因 `@proj-airi/i18n` 尚无构建产物失败，构建内部包后该问题消失。
- 第二次启动进入官方 SDK 与模型下载，随后失败退出。未出现可用 Vite 舞台，未做浏览器渲染验收。
- 环境代理对 `cubism.live2d.com` 和 `dist.ayaka.moe` 的 HTTPS CONNECT 返回 403；当前生效策略不允许这两个域名。保持代理及 TLS 设置，没有换镜像或绕过策略。
- 本任务未配置 DeepSeek secret，也没有用户可访问的安全端口预览入口；这与另一任务的真实文字测试成功分开记录。本轮无付费 API 调用。

## 当前机器恢复步骤

以下使用已保存工具链。在项目根目录执行；先确认 `vendor/airi` 的 HEAD 与锁文件一致、没有需要保护的修改。源码尚未下载的环境，应按 `scripts/airi.mjs` 的远端、干净工作区和固定提交检查流程获取，不能用重置覆盖已有修改。

```bash
export PATH=/workspace/toolchains/node-v26.7.0-linux-x64/bin:/workspace/toolchains/pnpm-11.24.0/node_modules/.bin:$PATH
cd /workspace/ds-zhubo/vendor/airi
git rev-parse HEAD
git status --short

pnpm --filter @proj-airi/stage-web... install --frozen-lockfile --ignore-scripts --store-dir /workspace/toolchains/pnpm-store --reporter append-only
pnpm -r --filter '@proj-airi/stage-web^...' --workspace-concurrency=2 --if-present run build

NODE_USE_ENV_PROXY=1 pnpm -F @proj-airi/stage-web dev --host 127.0.0.1 --port 5173 --strictPort
```

安装和内部包构建已完成，不必每次恢复都重装。上面为本轮实测的 Web 安装流程；根目录现有 `npm run setup:airi` 仍是全量安装流程，不应将两者混称。`NODE_USE_ENV_PROXY=1` 让 Node 使用环境已提供的代理，不会放宽域名策略。

启动前需要通过云环境配置流程允许：

| 域名 | 用途及源码依据 |
| --- | --- |
| `cubism.live2d.com` | `@proj-airi/unplugin-live2d-sdk@0.1.7` 下载 `sdk-web/bin/CubismSdkForWeb-5-r.3.zip` |
| `dist.ayaka.moe` | `apps/stage-web/vite.config.ts` 下载默认 Hiyori Live2D 与 AvatarSample VRM 资源 |

配置发布后必须重新检查本任务实际生效的策略，再重试。放行不保证后续所有启动步骤通过。如果出现新的失败，按真实日志继续诊断。

`127.0.0.1:5173` 是云机器内部地址，不是用户电脑能打开的链接。舞台启动后仍需安全的客户端访问方案；不可将开发服务直接无鉴权暴露到公网。资源使用范围需按实际模型及 SDK 的许可核对，开发下载不等于取得正式直播所需的全部授权。

## 能复用什么

以下均为固定版本的源码核对结果，还没有接入本项目运行验证。

| 能力 | AIRI 现有实现 | 本项目还缺什么 |
| --- | --- | --- |
| 人格 | `packages/stage-ui/src/stores/modules/airi-card.ts` 将系统提示、描述、人格、场景组合；角色卡保存在浏览器 localStorage | 中文助播卡、与服务端提示的一致性、实际对话验收 |
| 聊天记录 | `packages/stage-ui/src/stores/chat/session-store.ts` 使用 IndexedDB，按用户与角色组织会话 | 与 cohost 的已播历史对齐；不能把浏览器存储当跨设备云记忆 |
| 长期记忆 | `settings/memory/index.vue` 和 `settings/modules/memory-{short,long}-term.vue` 均为 WIP；character notebook 中的笔记与任务不能视为已完成的持久记忆系统 | 本场摘要、长期记忆的保存/检索/删除及隔离验证 |
| Live2D | 现成舞台、模型设置和 Live2D 模块，默认资源由 Vite 插件下载 | 成功下载、实际画面验收、项目回复/音频与口型联动 |
| 生成取消 | chat store 的 `cancelTurn`、`cancelPendingSends` 及流式 hooks | 映射本项目 version/turn 标识，防止旧结果进入新话轮 |
| 音频流 | speech runtime 的 `openIntent`，支持写入文本与取消；使用 Eventa 总线 | cohost 流式回复桥接、TTS、打断清队列、实际停声回执 |
| 播放状态 | speech bus 的 `speechOutputGetPlaybackState` 返回 `speaking` 布尔值 | `audioId`、实际开始/结束/停止及已播文本偏移；不能用布尔值或生成完成代替已播进度 |

AIRI 自带的 SparkNotify 编排还有独立模型调用。首版不把它串到每次主 AI 回答前；使用本项目导演的快速规则和异步语义接口，避免新增串行等待。现有 AIRI API 服务与身份系统也未部署，不将其默认服务地址当作本项目云同步。

## 虚拟直播间的下一步

1. 资源允许后跑通默认舞台，以实际截图、模型加载日志和控制台错误检查确认渲染。角色选择界面或空 canvas 不算成功。
2. 在受跟踪代码或可重放补丁中接入导演桥接，保留上游固定版本；不把唯一修改留在忽略目录。
3. 布局为左侧可选/自定义模拟弹幕，中间 AIRI 形象与字幕，右侧文字主播输入，下方事件时间线。第一轮只用文字，明确区分真实 DeepSeek 与模拟回复。
4. 人工/自动导演共享模型、人设和输入场景。人工点选发言；自动模式由决策触发消费。显示等待/忽略/附和/接话/打断及原因，统计错抢、漏接、首字延迟；不能把点击模拟 intent 当作真实语义判断通过。
5. 覆盖明确交棒、句中停顿、短附和、明确打断、弹幕洪峰与话题切换。之后才接 ASR/TTS 和实际播放反馈，验证真正的“何时该说话”。

当前话轮导演已有模拟测试与文字控制面板；完整虚拟直播间、AIRI 桥接和真实语音自然互动仍待实现/验收。
