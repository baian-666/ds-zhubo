# 转为本地主力开发

更新：2026-10-09。用户选择在当前 Windows 主力电脑本地开发。云端任务与 GitHub 保留项目记录，模型仍通过 DeepSeek API 使用；本地开发并不要求本机运行大模型。

## 已完成与尚未完成

- 旧云端代码、导演协议、模拟测试、AIRI 安装诊断都已本地提交保存。
- 本地任务必须核对是否包含 `apps/cohost/director.mjs`、`docs/TURN-DIRECTOR.md`、`docs/AIRI-SETUP.md`；旧远端 main 可能没有这些未推送改动。
- 旧云端终端是 Linux `/workspace/ds-zhubo`，不是用户 Windows 电脑；没有本机终端连接，尚未在用户设备安装工具链、下载源码或启动服务。
- 云端 secrets 不会随 Git 或备份迁移。本地配置用忽略的 `.env`，密钥不发到聊天，不打印、不提交。

## 一次性接续

1. 将最新受跟踪代码同步到已授权仓库，或从完整 Git bundle 恢复；不能只克隆旧 main 后假定已有导演功能。正常推送需先有用户明确授权；之前自动审批拒绝业务代码推送 main，旧授权仅覆盖 STATUS 文档更新。
2. 在 Codex 新建本地任务，选择本机已有项目目录；没有目录时选择一个用户指定的开发父目录，再由本地任务克隆同一个仓库。保留已有修改，不创建新的 GitHub 仓库、不 reset、不强推。
3. 本地任务先读 AGENTS 和交接文档，检查实际操作系统、目录、分支、提交、Git/Node/pnpm 和网络。可复用工具链时优先复用；版本按锁文件。
4. 初期使用本地服务与本地浏览器，不依赖云端端口预览。未来生产服务部署另行实施。

## Windows 原生开发路径

使用 Windows Node 26.7.0、npm 11.19.0、pnpm 11.24.0 和 Git。先检查已安装版本和系统架构，缺失时由具有本机终端权限的任务安装；不能将旧云端 Linux 二进制复制给 Windows 使用。WSL/Linux 已有且用户倾向复用时也可用，不把 WSL 或 Docker 作为必要前提。

在本机项目根目录：

```powershell
node --version
npm --version
pnpm --version
git status --short
npm run check
npm test
npm run dev
```

文字联调入口为本机 `http://127.0.0.1:8787`。浏览器测试须在服务确实启动后进行。根项目仅用 Node 内置模块，不需为了启动 cohost 额外安装依赖。

用本机编辑器配置 `.env`，保留 `HOST=127.0.0.1`、`PORT=8787`，填入 `DEEPSEEK_API_KEY`；模型先沿用已实测的 `deepseek-flash`，仍需在新设备实际检查可用性。`.env.example` 可作为模板。不能覆盖已有 `.env`，不复制云端密钥占位符。AIRI 与 cohost 的调用桥接仍待实现，不应为了配置方便把服务端密钥写进客户端源码。

## AIRI 安装

固定提交和依赖版本继续使用 `airi.lock.json`。先读上游 AGENTS，再安装；已有 `vendor/airi` 时检查 origin、HEAD 和修改，不覆盖已有工作。

现有 `scripts/airi.mjs` 明确拒绝 Windows，因此 Windows 原生任务不能声称 `npm run setup:airi` 已支持。本阶段可按下面的上游 Web 命令执行；源码获取必须沿用固定仓库/提交和工作区保护检查。后续若改跨平台脚本，需要实际 Windows 验证。

```powershell
# 先获取并核验 airi.lock.json 指定的仓库和提交到 vendor/airi
Set-Location vendor/airi
pnpm --filter @proj-airi/stage-web... install --frozen-lockfile --ignore-scripts
pnpm -r --filter '@proj-airi/stage-web^...' --workspace-concurrency=2 --if-present run build
pnpm -F @proj-airi/stage-web dev --host 127.0.0.1 --port 5173 --strictPort
```

安装跳过生命周期脚本是已用的 Web 安装范围，不代表桌面版和所有原生依赖已验证。如果本机需要代理，使用本机实际受支持的代理配置；不能照抄云端 `proxy:8080`。默认模型与 SDK 来自 `dist.ayaka.moe` 和 `cubism.live2d.com`，按本机真实网络结果诊断。下载成功后在本机 `http://127.0.0.1:5173` 验证实际形象渲染。

## 本地任务的首条消息

```text
继续 ds-zhubo，已改成本地主力开发。先读取 AGENTS.md、docs/HANDOFF.md、docs/STATUS.md、docs/CLOUD.md、docs/LOCAL-DEVELOPMENT.md、docs/AIRI-SETUP.md 和 docs/TURN-DIRECTOR.md。

检查当前目录、分支、提交及已有修改，确认包含此前导演与播放回执代码。保护已有修改，不新建 GitHub 仓库、不强推。检查本机 Git、Node 26.7.0/npm 11.19.0、pnpm 11.24.0；缺失时完成本地工具链安装。运行 npm run check 和 npm test，启动文字联调台并用本机浏览器验证，随后安装启动固定版本 AIRI 的默认舞台。密钥通过本机忽略的 .env 配置，不发到聊天、不打印。

接着实施文字虚拟直播间：可选/自定义模拟弹幕、文字模拟主播讲话、AIRI 形象与字幕、人工/自动导演和决策时间线。真人主播主导，优先验证何时该说话；不要在主 AI 快速回答前串行增加另一轮模型调用。已有异步导演与播放回执原型；复杂语义适配、完整虚拟直播间、真实语音和长期记忆尚未完成。用户已允许按需少量真实 API 测试，不购买资源、不正式直播。直接继续开发，完成检查并更新 STATUS。
```
