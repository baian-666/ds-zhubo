# DS 助播 · AIRI + DeepSeek

中文 Live2D 主播“小鲸鱼”：由她自主主持，真人作为搭档加入，保留助播方式。当前是 Windows 本机试播原型，主要目标是自然话轮和低延迟，尚未完成真人长期试播与真实 B 站送达验收。

日常双击 `启动小鲸鱼.cmd`。项目只提供桌面入口，独立网页版和旧浏览器控制台已移除。
当前部署与已知问题先读 [STATUS](docs/STATUS.md)，按任务查 [文档入口](docs/README.md)。

## 保存与找回版本

当前源码保存在 [GitHub 仓库](https://github.com/baian-666/ds-zhubo)。
移除网页版之前的源码标签为 `snapshot-20261020-before-desktop-only`。
完整的本机版本另用 `保存项目版本.cmd` 保存，包含源码、数据库与桌面构建，具体编号和恢复步骤见 [版本存档](docs/VERSIONS.md)。

GitHub 不包含 `.env`、聊天数据库、桌面导入模型、外置语音模型、安装依赖和本机存档。换电脑需要单独准备这些材料，不能只克隆代码就当作整机恢复。

## 本机安装与启动

已安装的本机继续使用启动脚本，不重复安装。新目录按 [本地开发](docs/LOCAL-DEVELOPMENT.md) 准备固定 Node 26.7.0、npm 11.19.0、pnpm 11.24.0，然后执行：

```powershell
./scripts/setup-local.ps1
./scripts/local.ps1 setup:airi
./scripts/local.ps1 setup:desktop
./scripts/local.ps1 build:desktop
```

`setup:airi` 只获取固定上游源码，拒绝覆盖已有修改；依赖安装与共享包构建由 `setup:desktop` 负责。
在忽略的 `.env` 配置本机凭据，随后双击 `启动小鲸鱼.cmd`。
模型导入、语音配置和试聊见 [桌面与语音](docs/DESKTOP-VOICE.md)，更新/回退见 [固定桌面](docs/DESKTOP-BUILD.md)。
本轮没有在全新机器重做安装验收，也没有制作独立安装包。

## 开发与检查

```powershell
./scripts/local.ps1 check
./scripts/local.ps1 test
./scripts/local.ps1 dev
# 另开终端，启动桌面源码调试：
./scripts/local.ps1 dev:desktop
```

8787 仅提供后端 API 和 `/healthz`，桌面页面继续使用 localhost:5174，以保留原来的本机数据来源。
网页启动、5173 舞台服务和浏览器控制台不再作为产品入口。
`integrations/airi` 与可重放补丁保存自有改动，`vendor/airi` 是忽略的上游工作区，不能在那里保存唯一源码。

## 边界与来源

DeepSeek 负责意识与导演，当前试用本地流式识别，Qwen 云端克隆负责发声。准确度、延迟、附和误停与长期记忆限制以 STATUS 的最新证据为准。
B 站接入见 [BILIBILI](docs/BILIBILI.md)；没有游戏操作和完整平台集成。
云端环境仅用于开发/检查，历史说明见 [CLOUD](docs/CLOUD.md)，不提供网页版预览。

- [固定 AIRI 上游与许可证](https://github.com/moeru-ai/airi/tree/34576c19f618a04e616657089f0688a8637873f2)
- [B 站官方接入示例](https://github.com/bilibili-openplatform/OpenLive_CSharpDemo)

模型与素材保留各自许可证；源码备份不代表素材的直播授权。
