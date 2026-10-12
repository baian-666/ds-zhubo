# DS 助播 · AIRI + DeepSeek

面向聊天陪伴、知识分享的 Live2D AI 助播。真人主播主导，AI 自然接话、选择性回复弹幕。目标平台为 B 站和微信视频号，不包含游戏操作。

**当前是 Windows 本机试播原型，尚不是可直接开播的产品。** 已有 AIRI 桌面/网页直播侧栏、同角色聊天气泡与导演时间线、DeepSeek 自主参与、小鲸鱼人格、鲸鱼娘 Live2D 连续表演，以及 AIRI 语音识别、合成和口型。真人识别质量、自然话轮和长期稳定性尚未验收；真实平台弹幕和生产部署未完成。

当前需求与实施顺序见 [开发基线](docs/DEVELOPMENT-BASELINE.md)。

当前推荐：本机安装后双击 `启动小鲸鱼.cmd` 使用桌面版，`启动网页版.cmd` 为备用。详见 [AIRI 直播入口与设置](docs/AIRI-CONSOLE.md)、[桌面与语音试播](docs/DESKTOP-VOICE.md)、[本地开发](docs/LOCAL-DEVELOPMENT.md)。下方云端配置保留为备选路径。

## 在另一台设备继续

当前主力为本机 Windows，换设备先同步已保存代码。云端开发作为备选；先阅读 [云端开发接续](docs/CLOUD.md)、[完整交接](docs/HANDOFF.md) 和 [当前状态](docs/STATUS.md)。

本仓库含开发草稿和项目上下文。云端对话、GitHub 代码备份、Codex Cloud 执行环境是三件独立的事。只有选中并发布关联本仓库的 Codex Cloud 环境后，才能在该环境中继续执行开发任务。

`.devcontainer` 用于下面的 GitHub Codespaces 备选开发方式，不会自动创建 Codex Cloud 环境。

### GitHub Codespaces 备选

[用 GitHub Codespaces 打开](https://codespaces.new/baian-666/ds-zhubo)

创建环境前查看 GitHub 显示的账户额度和机器配置。已经有 Codespace 时，从 [Codespaces 列表](https://github.com/codespaces) 恢复同一个环境。

开发容器自动安装与锁定 AIRI 源码对应的 Node 26.7.0、pnpm 11.24.0，并执行原型检查。**此配置尚未在真实 Codespace 中完成启动验收。**

进入终端后运行：

```sh
npm run dev
```

打开 Ports 中的 **8787** 预览页面，保持端口为 **Private**。即使没有 API Key，也可以检查页面、队列和控制状态。

要调用 DeepSeek：在 [Codespaces secrets](https://github.com/settings/codespaces) 添加 `DEEPSEEK_API_KEY`，授予本仓库访问权限，然后重启 Codespace 和服务。密钥不填入网页，也不提交到仓库。

默认模型为 `deepseek-flash`，关闭思考模式，按短句流式输出。可以通过 `DEEPSEEK_MODEL` 改为账号可用的模型。[DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)

既有真实 DeepSeek 文字试验结果见 STATUS；自动测试使用模拟模型，不消耗模型额度。语音设备链路通过不等同真人话轮通过。

## 启动 AIRI 舞台

另开终端：

```sh
npm run setup:airi
npm run dev:airi
```

打开 Ports 中的 **5173** HTTPS 预览地址。初次安装会拉取 AIRI 依赖并构建共享包，时间和磁盘占用明显多于文字联调台。按运行结果调整开发环境大小。

`airi.lock.json` 固定上游提交，不随 main 自动漂移。源码下载到忽略目录 `vendor/airi`。完整安装及浏览器渲染仍待云端验证。

**当前 8787 控制台与 AIRI 网页/桌面通过表演桥接连接。** AIRI 的麦克风和 Live2D 渲染发生在打开页面的直播设备。云端托管网页不会把渲染迁移到服务器。

不要直接在 `vendor/airi` 保存唯一的修改。后续 AIRI 适配需作为可重放补丁提交到本仓库，或迁入可推送的上游派生仓库，再更新初始化脚本。当前可重放补丁保存在 integrations/airi 与 scripts/patch-airi.mjs、scripts/patch-desktop.mjs。

## 目前可以测试

- 主播输入文字，DeepSeek 流式回复，并保存最近 6 轮完整对话作为短期上下文。
- 主播语音活动与识别文本进入导演；点击“让小鲸鱼停一下”取消请求与朗读，丢弃迟到结果。
- 静音后停止生成，并阻止新回答。
- 自动导演可按相关性选择合格模拟弹幕；人工模式保留主播点选。
- 全局弹幕回复冷却 20 秒，同观众冷却 60 秒，候选 20 秒过期。
- 消息按平台和 ID 去重，队列最多 128 条。

这是单直播场次的进程内原型。重启会丢失上下文和队列；跨设备长期记忆与配置同步尚未实现。当前包含语义自主参与和规则边界，仍有已登记的话轮与跨话题记忆问题；没有自动读取两个平台。

## 开发和检查

```sh
npm run check
npm test
```

原型只用 Node 内置模块，没有根项目第三方依赖。AIRI 依赖由它自己的 pnpm lockfile 管理。实际检查结果和下一步见 [项目状态](docs/STATUS.md)，架构见 [项目方案](docs/PROJECT.md)，最新的自然互动验证方案见 [交接说明](docs/HANDOFF.md)。

换设备前提交、推送代码，并更新 `docs/STATUS.md`。开发环境的未提交修改、浏览器设置和聊天记录不能替代仓库同步。

## 运行边界

- Codespaces 用于开发。正式直播的 AI 服务需要单独部署到云服务器。
- 原型默认只监听本机，使用 Codespaces 私有转发。不要把无认证端口改成 Public。
- 非本机监听要求 `COHOST_ACCESS_TOKEN` 至少 24 个字符。生产还需要 HTTPS、身份认证、持久化、调用额度限制和日志治理。
- 当前没有购买、启动云服务器或创建付费云开发实例，也没有开始推流。
- B 站接入走官方直播开放平台验证授权。视频号评论来源仍待核实。
- 当前使用 Windows 中文识别和系统朗读做最小试播，识别错字明显，后续按真人结果升级。用户角色模型尚未收到，音频口型未接入。

## 来源

- [AIRI 上游与许可证](https://github.com/moeru-ai/airi/tree/34576c19f618a04e616657089f0688a8637873f2)
- [B 站官方直播接入示例](https://github.com/bilibili-openplatform/OpenLive_CSharpDemo)
- [Codespaces 文档](https://docs.github.com/en/codespaces)

AIRI 源码与其素材保留原有许可证，示例素材不自动代表适用于本项目的直播授权。
