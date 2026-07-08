# API 总览(M1 只读)

## Base URL

`http://127.0.0.1:7777`(严格 localhost,无鉴权)

## REST 端点

| Method | Path | 说明 |
|---|---|---|
| GET | /api/health | 健康检查:CLI 版本、daemon 状态、数据目录可达性 |
| GET | /api/dashboard | 仪表盘聚合:需处理/运行中会话、统计条、时间线、7 日热力、Token 成本树 |
| GET | /api/projects | 项目列表(过滤噪音目录),含 git 状态、会话/经验计数、7 日热力 |
| GET | /api/sessions | 会话看板:`claude agents --json --all` + jobs state 补充,按状态归列 |
| GET | /api/sessions/:sessionId/replay | 只读回放:session jsonl → 结构化事件流(未知类型降级 raw) |
| GET | /api/skills | 技能列表(user / plugin / disabled),含 SKILL.md 正文 |
| GET | /api/memories | 全部项目 memory 聚合(frontmatter + 正文 + [[链接]]) |
| GET | /api/memories/search?q= | FTS5 全文搜索(trigram,支持中文) |
| GET | /api/usage/today | 今日 Token 用量/成本,项目 → 会话两级(含口径说明) |
| GET | /api/crons | 定时任务:M1 仅只读列出系统 crontab |

## WebSocket

`ws://127.0.0.1:7777/ws` — 服务端单向推送 `{type:"changed", scope:"history"|"skills"|"jobs"}`,前端据此重取对应资源。M2 扩展为对话双向流与审批通道。

## 响应约定

- 成功:`200` + 数据本体(无 envelope)
- 错误:`4xx/5xx` + `{error: string}`
- 所有统计数字附 `caliber` 字段说明口径(数据源与聚合方式)——全局 R8。

## 数据新鲜度

- 会话看板:前端 5s 轮询(CLI 出口,便宜)
- 历史/技能/经验:ws 变更推送触发重取
- Token 用量:后端 60s 内存缓存
