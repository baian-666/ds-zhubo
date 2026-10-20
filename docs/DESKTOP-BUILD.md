# 固定构建桌面版

日常双击项目根目录的 `启动小鲸鱼.cmd`。入口启动或复用直播后端，直接运行已构建的 Electron 主进程和页面。它不运行 Vite 开发服务器、补丁脚本、安装依赖或编译。2026-10-20 起仅保留桌面产品入口，独立网页版已移除。

这是本机固定构建，还依赖本仓库的工具链和 AIRI node_modules；不是可分发安装包。不要只复制产物文件夹到其他电脑。

## 保留的数据与运行边界

- 桌面页面继续使用 `http://localhost:5174`，用户数据仍在 `data/desktop-profile`。原有 IndexedDB 模型、角色卡、外观与设置不换来源。
- 桌面进程托管只读的回环静态服务。它只提供该版 renderer 产物，不提供源码、目录列表或 `.env`；拒绝路径穿越和其他 Host。
- 重复双击会聚焦已有主窗口。关闭 Electron 后，静态服务一起退出；直播后端和可复用的 IndexTTS 服务不随之退出。
- 语音密钥仍在根目录忽略的 `.env`。构建不读取该文件，也不向子进程传递已有模型密钥或助播访问令牌。运行时仅读取助播访问令牌用于本机桥接。
- 本机版本禁用 AIRI 上游更新器，包括开发环境的模拟更新。更新通过本项目的显式构建入口完成。
- 构建产物位于 `vendor/airi/apps/stage-tamagotchi/out/cohost-builds/<版本>/`。它们被 Git、lint 与 pnpm workspace 排除。

## 更新与回退

源码修改完成并通过对应检查后，双击 `更新桌面构建.cmd`，或运行：

```powershell
./scripts/local.ps1 build:desktop
```

每次构建写新目录，不改正在运行的版本。构建成功并核验主进程、预加载和页面入口后，原子替换 `data/desktop-build.json` 中的当前版本。失败不切换版本，也不会自动退回开发模式。固定锁文件和限制打包并行度用于控制依赖与构建资源消耗。

构建成功后，从托盘退出旧桌面，再双击启动入口。若原窗口还在，重复启动会复用它，不会强制中断正在说话的小鲸鱼。

回退到上一次完整构建：

```powershell
./scripts/local.ps1 rollback:desktop
```

退出并重开后生效。回退只选择桌面代码，不回退聊天、模型或 `.env`。如果依赖锁版本已变化，启动会拒绝混用并要求重新构建。源码热更新调试仍用 `./scripts/local.ps1 dev:desktop`，与固定桌面互斥占用 5174。

每次行为修改或部署前后，按 [版本存档](VERSIONS.md) 保存源码、数据库、当前/上一版完整桌面及依赖锁。
根目录 `保存项目版本.cmd` 提供统一入口；单独的 `rollback:desktop` 和构建编号不代表整套程序可回退。

## 磁盘维护

2026-10-16 清理了 16 份过期/失败桌面构建，保留 `data/desktop-build.json` 指向的当前版 `20261016T070930236Z-707d8545` 和上一版 `20261015T163208538Z-5c946de5`。更早的固定桌面产物已删除；源码检查点与数据库备份保留。旧文档中的构建编号是历史证据，不表示该产物仍可直接启动。

同时使用项目自带 uv 清空 `data/indextts/uv-cache` 下载/构建缓存，保留 `.venv`、Python、模型和音色文件。文件逻辑合计由 44.885 GiB 降到 30.648 GiB；磁盘可用空间观测增加 5.809 GiB。两者差异主要因为缓存与已安装环境使用硬链接，共享内容不能重复计作物理释放量。原始盘点与删除清单见 `data/storage-before-20261016.json`、`data/storage-after-20261016.json`、`data/storage-cleanup-20261016.json`。

后续清理应先检查构建指针和实际运行版本，至少保留当前、上一版以及仍在运行的版本；只有确认路径在项目内、无目录链接且未被使用的旧构建才可移除。构建流程目前仍会保留全部版本，没有新增自动删除行为。uv 缓存可由其 `cache clean --cache-dir` 命令清理，下次安装依赖可能需要重新下载。不要按名称批量删除 `data`、`hf_cache`、`desktop-profile` 或 `node_modules`：其中包含运行模型、用户模型与依赖。Aqua 的安装脚本目前还读取 `G2PWModel_1.1.zip`，该压缩包也保留。

2026-10-20 起，`data/version-archives/desktop/` 是完整版本存档的共享依赖，不属于上述可清理的普通构建缓存。

本次只清理生成物和更新忽略规则/文档，未改应用代码、未重启服务。当前/回退构建入口哈希均通过，桌面健康接口仍返回原运行 PID 210036，Index 环境 `torch` 导入通过，`.env` 指纹一致；未重复执行应用测试或语音试听。

随后按用户要求将12.181 GiB语音模型移到项目外，旧路径保留目录联接；项目不跟随联接约18.470 GiB。详情及备份边界见[本机外置语音模型](LOCAL-DEVELOPMENT.md#本机外置语音模型)。上面的30.648 GiB为外置前盘点，不能与外置大小重复计作释放空间。

## 故障与验证

启动入口会等待主窗口出现。缺少构建、端口冲突或 Electron 提前退出会弹出提示；详细日志位于 `data/start-desktop.log`、`data/desktop-launch.err.log`。日志不包含配置密钥。不要为绕过错误清空 `desktop-profile`。

- Node 测试：`npm run check`、`npm test`，包含构建完整性、失败不切版、回退、静态服务边界和端口冲突。
- AIRI：`./scripts/local.ps1 check:desktop` 和 `./scripts/local.ps1 check:airi`；全仓的既有 IPv6 回环阻挡见 [AIRI-CHECKS](AIRI-CHECKS.md)。
- 桌面烟测：设置 `PLAYWRIGHT_MODULE` 为已安装 Playwright 的入口后，用固定 Node 运行 `scripts/desktop-smoke.mjs`。验证真实 Electron、模型标识、设置窗口、重复启动和无开发请求。
- 加 `--voice` 会发送一条真实 DeepSeek 短句并使用当前 TTS，随后测试试听取消；不会开麦。需要服务凭据与可用声音服务，结果保存在 `data/desktop-fixed-smoke.json`。

启动计时是本机单次进程重启观测，包含入口脚本、窗口和页面加载，不是系统重启后的统计基准。播放回执表示软件已调度/完成音频，不代表测到了扬声器物理首声。最新验收见 [STATUS](STATUS.md)。
