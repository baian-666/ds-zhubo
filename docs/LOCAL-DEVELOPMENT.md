# 转为本地主力开发

当前入口更新：2026-10-20。Windows 本机桌面是唯一产品入口，独立网页版已移除。GitHub 保存源码；当前试用本地流式识别，DeepSeek/Qwen 仍使用云端服务。下方迁移背景不代表当前部署。

## 当前 Windows 接续入口

本机固定工具链由 scripts/setup-local.ps1 与 scripts/local.ps1 管理，不需替换系统 Node。AIRI 获取入口为 setup:airi，桌面依赖安装为 setup:desktop，日常启动使用固定构建。

日常双击 `启动小鲸鱼.cmd` 打开桌面原生直播侧栏；操作与设置边界见 [AIRI 本机直播入口](AIRI-CONSOLE.md)，语音说明见 [桌面与语音试播](DESKTOP-VOICE.md)。8787 仅提供后端 API，旧文字控制页已移除。实际验收以 STATUS 最新记录为准。

本场记录默认写入忽略的 `data/cohost-session.sqlite`，后端重启自动恢复有限上下文。管理入口在 AIRI“设置 → 直播助播 → 本场记录与记忆”。旧 `--room-snapshot` 仅用于空数据库首次迁移；日常启动不再携带此参数。备份、恢复边界和临时回退见 [场次持续性](SESSION-MEMORY.md)。

声音服务与音色也保存到该数据库的独立配置表，在 AIRI“发声／语音合成”修改。旧 `.env` 声音字段只用于首次导入，密钥仍仅留本机 `.env`；后续直接修改旧声音环境变量不会覆盖已保存值。迁移与回退见 [普通配置仓库](RUNTIME-SETTINGS.md)。

B站弹幕采用 blivechat 本地版：双击 `配置B站弹幕.cmd`，在本机 8791 配置身份码，工具后台为 12451，保存后从 AIRI“当前配置”点击连接。无需申请自己的开发者应用。见 [B站弹幕说明](BILIBILI.md)。

桌面日常入口现在使用固定构建。源码改动后运行 `./scripts/local.ps1 build:desktop`，成功后退出并重开桌面；`dev:desktop` 专门用于源码热更新。构建失败保留上一版，详见 [固定桌面构建](DESKTOP-BUILD.md)。

## 已完成与尚未完成

- 旧云端代码、导演协议、模拟测试、AIRI 安装诊断都已本地提交保存。
- 本地任务必须核对是否包含 `apps/cohost/director.mjs`、`docs/TURN-DIRECTOR.md`、`docs/AIRI-SETUP.md`；旧远端 main 可能没有这些未推送改动。
- 旧云端终端是 Linux `/workspace/ds-zhubo`；当前 Windows 工作区为 `D:\ds-zhubo`，固定工具链和 AIRI 已本机安装。
- 云端 secrets 不会随 Git 或备份迁移。本地配置用忽略的 `.env`，密钥不发到聊天，不打印、不提交。

## 一次性接续

1. 同步现有 GitHub 仓库，或从已校验存档恢复。2026-10-20 用户已明确授权将当前源码及未上传提交历史公开推送，移除网页版前标签为 snapshot-20261020-before-desktop-only。密钥、数据库和模型仍不随 Git 上传。
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
npm ci --ignore-scripts
npm run check
npm test
npm run dev
```

本机后端为 `http://127.0.0.1:8787`，存活检查用 `/healthz`，业务接口用 `/api/`；根路径不再提供控制页面。根项目使用固定依赖，首次安装运行 npm ci 或 scripts/setup-local.ps1。不需要安装整套 AIRI 就能运行后端测试。全仓依赖与验证入口见 [AIRI 检查说明](AIRI-CHECKS.md)。

用本机编辑器配置 `.env`，保留 `HOST=127.0.0.1`、`PORT=8787`，填入 `DEEPSEEK_API_KEY`；模型先沿用已实测的 `deepseek-flash`，仍需在新设备实际检查可用性。`.env.example` 可作为模板。不能覆盖已有 `.env`，不复制云端密钥占位符。AIRI 与 cohost 已有可重放的表演桥接，服务端密钥不得写进客户端源码。

## 本机外置语音模型

2026-10-16 已将六个模型目录（51 个文件，12.181 GiB）同盘移动到 `D:\ds-zhubo-models`。项目旧位置保留 Windows Junction（目录联接），现有服务、试听和下载脚本仍使用原路径，无需修改 `.env` 或声音配置。Python 环境、参考音频、试验结果与聊天数据仍在项目内。

| 项目内入口（相对项目根目录） | 外置位置（相对 `D:\ds-zhubo-models`） |
| --- | --- |
| `data/indextts/repo/checkpoints` | `indextts/checkpoints` |
| `data/qwen-local/model` | `qwen-local/model` |
| `data/aqua-tts/GPT-SoVITS/GPT_SoVITS/pretrained_models` | `aqua-tts/pretrained_models` |
| `data/aqua-tts/GPT-SoVITS/GPT_SoVITS/text/G2PWModel` | `aqua-tts/G2PWModel` |
| `data/aqua-tts/whisper-base` | `aqua-tts/whisper-base` |
| `data/aqua-tts/whisper-small` | `aqua-tts/whisper-small` |

不跟随目录联接统计时，项目约 18.470 GiB，外置模型约 12.181 GiB；同盘搬移没有减少 D 盘总占用。部分文件管理器会跟随联接，显示的项目大小仍可能包含模型。备份项目时应跳过这些联接，模型目录独立备份；换电脑或改变路径后要按表重建联接，不能仅复制项目就假定模型已随行。当前这是本机部署约定，尚无跨平台自动迁移功能。

重建联接时先确认目标模型完整且原入口不存在，例如：

```powershell
New-Item -ItemType Junction -Path 'D:\ds-zhubo\data\indextts\repo\checkpoints' -Target 'D:\ds-zhubo-models\indextts\checkpoints'
```

恢复项目内存放时，先停止使用相关本地模型的服务，确认原入口确实是 Junction；仅删除联接本身（不能递归删除其内容），再把对应外置目录移回表中原位置。不要直接清空或删除外置模型文件夹。

迁移前后逐文件 SHA256 与大小一致，六个联接和旧路径均可读，Index 配置解析通过，`.env` 指纹一致，桌面原 PID 210036 持续响应。迁移时 Index/Aqua 本地服务未运行，当前正式 Qwen 为云端声音；未启动本地模型进行合成或重新试听。未修改应用源码，未执行应用测试。操作清单与验证结果为 `data/model-relocation-plan-20261016.json`、`data/model-relocation-result-20261016.json`，含完整原路径、目标路径及文件校验值。

## AIRI 安装

固定提交和依赖版本继续使用 `airi.lock.json`。先读上游 AGENTS，再安装；已有 `vendor/airi` 时检查 origin、HEAD 和修改，不覆盖已有工作。

在新目录获取固定 AIRI 源码后安装桌面依赖并构建。已有工作区不重复运行源码获取；保护检查会拒绝覆盖 vendor 中已有修改。

```powershell
./scripts/local.ps1 setup:airi
./scripts/local.ps1 setup:desktop
./scripts/local.ps1 build:desktop
```

setup:airi 只获取源码，setup:desktop 安装依赖并构建共享包。模型与 SDK 的下载按本机真实网络诊断；不要照抄历史云端代理地址。完成后使用固定桌面核验形象。本次没有在全新机器重复安装验收。

## 本地任务的首条消息

```text
继续 ds-zhubo。先读 AGENTS.md 和 docs/STATUS.md，按 docs/README.md 选取当前任务的专题，不默认加载历史。
保护本机现有修改、数据库和模型。只提供桌面产品入口，8787 为后端 API，5174 为桌面页面。按任务修改、检查、保存版本并更新精简 STATUS。
密钥仅留忽略的 .env；源码改动保存在 integrations/airi 与重放脚本。不要只修改 vendor，不清空桌面用户数据，不强推。
```

## 表演版本的 AIRI 本机补丁

构建/调试桌面时，patch-desktop.mjs 调用 patch-airi.mjs 准备共享补丁，并将 integrations/airi 源码应用到固定版本。不再生成已删除的浏览器父页面桥接。补丁不需要把 DeepSeek 密钥填进 AIRI。

已经应用补丁的 vendor/airi 会显示本机修改，setup:airi 会拒绝重置它。日常使用固定桌面，源码调试用 dev:desktop。表演源码保存在 integrations/airi，不能只留在 vendor；历史验证见 docs/LIVE2D-PERFORMANCE.md。
