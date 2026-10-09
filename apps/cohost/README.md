# 助播文字原型

`npm run dev` 启动单场次联调服务和网页。代码没有引入额外第三方运行时依赖。

| 文件 | 作用 |
|---|---|
| `scheduler.mjs` | 主播优先、取消信号、消息队列、去重与冷却 |
| `director.mjs` | 快速话轮判断、异步语义接口、候选过期与主动参与预算 |
| `deepseek.mjs` | 服务端 DeepSeek 流式调用与 SSE 解析 |
| `server.mjs` | HTTP 输入验证、权限、短期上下文与响应流 |
| `index.html` | 手动模拟主播与观众事件 |

所有 `/api/` 路由在设置访问令牌后要求 `Authorization: Bearer <COHOST_ACCESS_TOKEN>`。POST 使用 `application/json`。只有 `/` 与 `/healthz` 不要求令牌。

| 路由 | 请求 |
|---|---|
| `GET /api/status` | 无请求体 |
| `POST /api/reply` | `{ "source": "host", "text": "你好" }` 或 `{ "source": "viewer" }` |
| `POST /api/host-speaking` | `{ "value": true }`，开始讲话并打断；false 表示结束讲话 |
| `POST /api/mute` | `{ "value": true }` |
| `POST /api/interrupt` | `{}` |
| `POST /api/reset` | `{}`，清上下文与队列，保留限流状态 |
| `POST /api/danmaku` | `{ "id": "1", "platform": "bilibili", "userId": "viewer-1", "text": "你怎么看", "mentioned": true, "selected": false }` |

回复流为 NDJSON，事件有 `start`、`delta`、`done`、`cancelled`、`error`，均携带话轮和音频标识。文字模式保留原流程；`delivery:audio` 在生成结束后等待实际播放回执，尚未接真实音频。新增 `/api/director/event` 和 `/api/playback`，协议、模拟方式及局限见 [话轮导演](../../docs/TURN-DIRECTOR.md)。

此原型不适合直接公开提供多人服务，不包含平台连接器、自动语义评分、持久化或播出内容审核流程。
