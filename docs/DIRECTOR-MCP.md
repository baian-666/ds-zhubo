# 导演的信息 MCP 与桌面入口

2026-10-18，范围为直播现场、公开资料搜索、网页读取。界面直接嵌入 AIRI 原生「直播助播」设置，未新建独立浏览器页面。

## 连接与所有权

- 根依赖固定 `@modelcontextprotocol/sdk@1.32.1`。首次用 AIRI 锁中的1.30.0，npm audit报告已知OAuth漏洞后改为修复版本；最终audit为0。没有新增OAuth、账户或密钥。
- 本机 `cohost-live` MCP Server 使用 SDK InMemoryTransport，作用域绑定一次导演判断，真实执行 initialize、tools/list、tools/call。`live_context`读取实时直播/主持状态、主播输入、已播/正在播内容和最近8条现场消息。不是暴露到网络的通用代理，也不把整个状态对象或凭据送往搜索服务。
- 远程连接 `https://mcp.exa.ai/mcp`，Streamable HTTP。实际发现 `web_search_exa(query, objective, numResults)`、`web_fetch_exa(urls, maxCharacters)`。本机适配为简短的 `web_search(query)`、`web_read(url)`，不开放其他工具或接收服务方指令作为系统规则。
- 每次判断持有自己的连接；发现和调用带取消信号与10秒单请求期限，轮次最多3次。只有实际选择查询后，普通4.5秒判断期限才可延长，绝对上限30秒。角色/主播修订、静音、人工停止和候选有效性仍由运行时校验。
- 正常参与时由模型在 `participate` 与三个信息工具中选择一个；不增加普通闲聊的预规划调用。DeepSeek采用`tool_choice=required`，禁用思考模式，避免普通文本绕过协议。查询完成后继续同一消息链，最终仍由原流式记录协议送出首句和表演。
- 明确点名邀请在自主参与开启时也进入统一生成；确定性叫停仍直接执行。边听短反应、让话、提前准备、已有语音正在播的判断不查询。纯手动回复与非流式调试路径保持原行为。

## 数据与执行边界

- 搜索仅发送最多240字的查询与固定检索目标；网页读取仅发送一个已提供的公开URL。不能请求本机IP、带凭据/自定义端口的URL、内部域名、任意编造的网页地址或文件协议。
- 查到的外部正文最多10000字符，传给模型时标明不可信资料与获取时间。网页中的命令不能获得执行权限或成为可写手册的主播证据；原有完整原话、角色、场次、修订校验继续生效。
- 公开链接从实际返回正文提取，最多8个；页面正文不作为HTML渲染。查询与结果摘要（最多1000字）只保留有界内存记录，当前角色最近12条可见，服务全局最多36条。清空本场/重启会清理查询日志，长期反馈仍按原规则保存。
- MCP失败、限流、无内容、取消有独立状态，不能伪装成功。失败提示不打印供应商原始异常或凭据。模型不能给读取失败的网页归因；语义质量仍需真人观察。
- `/api/director-handbook`继续是受保护的API，增加连接/查询记录。`POST /api/director-tools/check`只做发现检查。主状态流只推送手册与工具修订号，设置按需刷新；不在每个音频状态包携带完整手册。

## 验证

- Node check与438项测试通过。新增真实本机MCP握手/调用、模拟远端MCP读写协议、来源与URL限制、取消/失败/截断、预算、首句提前流出、普通聊天无额外请求、查询延长但插话不能恢复旧答案等测试。
- 原生设置组件的真实Chromium/Vue测试通过：添加反馈、后台更新时保留草稿并阻止过期保存、切换角色移除旧草稿。使用网络边界替身，未改生产手册。
- 第一轮真实DeepSeek+Exa：现场和搜索成功，旧IAU网页读取失败。模型先承认失败，随后仍说“IAU页面也强调”，收紧失败后归因规则。保留`data/director-mcp-trial-1792300392701.json`。
- 第二轮改读搜索返回的当前IAU官方页，读取成功，但普通闲聊偶发普通文本绕过工具，改用`required`。保留`data/director-mcp-trial-1792300492064.json`。
- 第三轮4/4：普通闲聊无工具/1255ms，现场1897ms（本机MCP16ms），公开搜索4928ms（MCP2684ms），指定网页3197ms（MCP1558ms）。计时为请求开始至首个决定；合成文本、无ASR/TTS、无真人直播，不是端到端语音延迟。`data/director-mcp-trial-1792300572403.json`，无自动重试。
- 新工具模式没有额外的常识核验器；可能遗漏查询、搜索不相关或归纳不准确。以上有限样本不证明所有最新信息正确。没有连接游戏、屏幕视觉或任意文件操作。

复跑：[director-mcp-trial.mjs](../scripts/director-mcp-trial.mjs) `--real`使用本机已有DeepSeek凭据，只发合成输入，保留每次结果。桌面部署及最终类型/lint/构建证据见[STATUS](STATUS.md)。

## 当前部署

- 后端267512，固定桌面`20261018T052645776Z-3481ce49`。先备份SQLite、核对空闲状态，再重启指定旧进程；原300聊天、角色、声音、手册、服务、.env指纹全部一致。备份`data/session-backups/director-mcp-1792301280604.sqlite`，核对`data/director-mcp-deployment.json`。
- 实际后端的本机MCP和远程Exa工具发现都成功，`data/director-mcp-deployed-check.json`；旧手册URL返回404。生产手册0条，未写入试验偏好，自动学习开启。
- 真实Electron烟测验证原生设置组件存在、无手册iframe、保留显示模型、实际Qwen配置一致、重复启动复用、无开发服务器请求或前端错误。主持off、关麦，舞台就绪。`data/desktop-fixed-smoke.json`、`data/director-mcp-native-smoke.log`与截图`data/director-handbook-native.png`。该烟测未开启真人麦克风。
- 日志：`data/director-mcp-check.log`、`data/director-mcp-all-tests.log`、`data/director-settings-browser.log`、`data/airi-check-typecheck.log`、`data/airi-check-lint.log`、`data/director-mcp-desktop-build.log`。lint仅683项已有警告。

## 源码与协议参考

- [MCP适配器](../apps/cohost/director-tools.mjs)、[流式查询循环](../apps/cohost/participation-stream.mjs)、[生命周期](../apps/cohost/task-scope.mjs)、[参与判断](../apps/cohost/participation.mjs)。
- [共享数据契约](../packages/cohost-contracts/director.ts)、[原生设置组件](../integrations/airi/cohost-director-settings.vue)、[可重放补丁](../scripts/patch-console.mjs)。
- [协议回归](../tests/director-tools.test.mjs)、[界面回归](../integrations/airi/cohost-director-settings.browser.test.ts)。
- [官方MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)、[Exa官方MCP仓库](https://github.com/exa-labs/exa-mcp-server)、[DeepSeek工具选择协议](https://api-docs.deepseek.com/api/create-chat-completion/)。
