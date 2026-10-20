# 桌面助播后端

这是 AIRI 桌面使用的本机 API 服务，入口为 `server.mjs`。独立网页版和旧浏览器控制台已移除。

- `/healthz` 提供存活检查；`/api/` 提供角色、配置、聊天、导演、识别、播放和状态流接口。
- `/`、`/index.html`、`/client.mjs`、`/stage-bridge.mjs` 不再提供页面或脚本。
- 模型凭据仅留本机环境；SQLite、日志和录音在忽略的 `data/`，不随 Git 上传。
- API 中已有的舞台类型与来源校验仍供共享组件及回归使用，不代表独立网页版仍受支持。

日常通过根目录 `启动小鲸鱼.cmd` 启动。开发入口为 `npm run dev`，检查为 `npm run check` 与 `npm test`。
自然话轮、识别和长期记忆的实际限制见 [当前状态](../../docs/STATUS.md)，存档/恢复见 [版本管理](../../docs/VERSIONS.md)。
