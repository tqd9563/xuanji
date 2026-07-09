# API 总览(M1 只读 + M2 派发)

## Base URL

`http://127.0.0.1:7777`(严格 localhost,无鉴权)

## REST 端点

| Method | Path | 说明 |
|---|---|---|
| GET | /api/health | 健康检查:CLI 版本、daemon 状态、数据目录可达性 |
| GET | /api/dashboard | 仪表盘聚合:需处理/运行中会话、统计条、时间线、7 日热力、Token 成本树 |
| GET | /api/projects | 项目列表(过滤噪音目录),含 git 状态、会话/经验计数、7 日热力 |
| GET | /api/sessions | 会话看板:`claude agents --json --all` + jobs state 补充,再注入后端进程内存活的派发会话(实时状态/会话名/dispatchId 覆盖,CLI 未收录的补合成卡),按状态归列 |
| GET | /api/sessions/:sessionId/replay | 只读回放:session jsonl → 结构化事件流(未知类型降级 raw) |
| GET | /api/skills | 技能列表(user / plugin / disabled),含 SKILL.md 正文 |
| GET | /api/memories | 全部项目 memory 聚合(frontmatter + 正文 + [[链接]]) |
| GET | /api/memories/search?q= | FTS5 全文搜索(trigram,支持中文) |
| GET | /api/usage/today | 今日 Token 用量/成本,项目 → 会话两级(含口径说明) |
| GET | /api/crons | 定时任务:M1 仅只读列出系统 crontab |
| GET | /api/sessions/:sessionId/can-resume | resume 所有权预检(终端存活 interactive → 拒绝) |
| POST | /api/skills/:name/toggle | 技能启停(铁律例外②:`{enable, confirm:true}` 双确认,目录移动可逆) |
| PUT | /api/sessions/:sessionId/name | web 会话重命名(display-name 存自有 SQLite,终端存活会话 403) |
| POST | /api/dispatch/handoff | 跨目录交接:`{sessionId}` → haiku 生成结构化摘要(结论/未完成/口径) |
| POST | /api/sessions/:sessionId/close | 关闭会话:`{confirm:true}`;自有隐藏列表(不写 ~/.claude,可逆),进程内存活的派发会话额外终止其子进程;终端存活 403 / 运行中 bg 任务 409 |

## WebSocket

### /ws — 变更推送(单向)

`{type:"changed", scope:"history"|"skills"|"jobs"}`,前端据此重取对应资源。

### /ws/dispatch — 派发双向流(每个派发页一条连接)

client → server:
- `{op:'start', cwd, permissionMode, model?, resume?, name?, prompt}` 开始/续接会话(resume 先过所有权检查;目标为 bg 后台代理会话时自动 `forkSession` 分叉副本续接——daemon 持有原会话,CLI 拒绝直接 --resume)
- `{op:'send', text}` 后续轮次输入(SDK streaming-input)
- `{op:'permission', requestId, decision:'allow'|'always'|'deny'}` 审批决定(allow 回传原始 input;always 附 SDK suggestions)
- `{op:'interrupt'}` 打断当前回合
- `{op:'bg', cwd, prompt}` 转后台(claude --bg,daemon 托管)
- `{op:'attach', dispatchId}` 重连并回放事件

server → client(DispatchEvent):
`init`(sessionId/model) · `status`(working/awaiting-permission/idle/ended) · `delta`(打字机增量) · `assistant`(定稿文本) · `tool` / `tool-result` · `permission-request` / `permission-resolved` · `result`(costUsd/contextPct) · `rate-limit`(five_hour/seven_day 利用率,来自 SDK rate_limit_event) · `user-echo` · `forked`(bg 会话分叉续接:from/to) · `bg-dispatched` · `error`(子进程异常退出时附 stderr 尾部)

派发会话完成/等待审批时,后端经 osascript 直发 macOS 横幅(仅璇玑派发的会话)。

## 响应约定

- 成功:`200` + 数据本体(无 envelope)
- 错误:`4xx/5xx` + `{error: string}`
- 所有统计数字附 `caliber` 字段说明口径(数据源与聚合方式)——全局 R8。

## 数据新鲜度

- 会话看板:前端 5s 轮询(CLI 出口,便宜)
- 历史/技能/经验:ws 变更推送触发重取
- Token 用量:后端 60s 内存缓存
