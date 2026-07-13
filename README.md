# 璇玑 xuanji

> 「在璇玑玉衡,以齐七政」— Mission control for your AI production: watch every agent in orbit, and keep them aligned.

跑在本机的单用户 Web 应用,把散落在 `~/.claude/` 里的 AI 生产资料(项目、会话、技能、经验、定时任务)聚合成一个深色驾驶舱,并能直接从浏览器派发和跟进 Claude 任务。

## 功能概览

- **仪表盘**:需要处理的会话、运行中任务、跨项目活动时间线、7 日热力、Token 成本(按项目下钻到会话)
- **项目总览**:自动发现 `~/.claude/projects/` 全部项目,含 git 状态、会话数、经验数、活跃度
- **会话看板**:类 `claude agents` 的四列看板(空闲/运行中/等待输入/已完成),只读回放任意会话,键盘优先操作
- **技能一览**:user/plugin 技能清单与 SKILL.md 预览(M1 只读)
- **经验沉淀**:聚合全部项目的 memory,类型/项目双维浏览 + FTS5 全文搜索
- **定时任务**:只读展示系统 crontab(应用内调度器在 M3)
- 派发通道(Agent SDK 对话 + 审批 + resume + 转后台)在 M2

## 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 后端 | Node.js + TypeScript + Hono + ws | Node ≥ 20 |
| 包管理 | pnpm | 9.x |
| 存储 | SQLite(better-sqlite3 + Drizzle,仅自有数据与可重建索引)| — |
| 前端 | React + Vite + Tailwind + shadcn/ui | — |
| Claude 集成 | `@anthropic-ai/claude-agent-sdk` 为主,`claude` CLI 子进程为辅 | CLI 2.1.x |
| 测试 / Lint | vitest / eslint + `tsc --noEmit` | — |

## 快速开始

### 环境要求

- Node.js 20+,pnpm 9+
- 本机安装 Claude Code CLI(`claude` 在 PATH 中),存在 `~/.claude/` 数据目录

### 安装

```bash
git clone https://github.com/tqd9563/xuanji.git
cd xuanji/code/backend && pnpm install
cd ../frontend && pnpm install
```

### 启动(日常使用:launchd 常驻)

```bash
cd code/frontend && pnpm build        # 构建 SPA(后端直接托管)
cd ../backend && pnpm launchd:install # 安装 LaunchAgent:开机自启 + 崩溃 5s 拉起
# 浏览器打开 http://127.0.0.1:7777
```

卸载常驻:`pnpm launchd:uninstall`;日志在 `~/Library/Logs/xuanji/`。

### 启动(开发)

```bash
# 后端(127.0.0.1:7777)
cd code/backend && pnpm dev

# 前端(Vite dev server,代理 /api 与 /ws 到后端)
cd code/frontend && pnpm dev
```
开发时先 `pnpm launchd:uninstall` 释放端口,避免与常驻实例冲突。

### 测试与检查

```bash
cd code/backend
pnpm test        # vitest(含 adapter 契约测试)
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
```

## 项目结构

```
xuanji/
├── CLAUDE.md                # Agent 规则(技术栈铁律、架构约束)
├── PRODUCT.md               # 产品战略(register/用户/原则)
├── DESIGN.md                # 设计规范唯一 source of truth(OKLCH token + 六段式)
├── code/
│   ├── backend/             # Hono API + ws + Adapter 层 + SQLite
│   │   ├── src/
│   │   │   ├── adapters/    # ★ 唯一允许解析非公开格式的地方
│   │   │   ├── services/    # 领域服务(projects/sessions/skills/memories/usage/dashboard)
│   │   │   ├── storage/     # better-sqlite3 + FTS5(可重建索引)
│   │   │   └── api/         # 路由
│   │   └── tests/           # vitest + fixture 契约测试
│   └── frontend/            # React SPA(七视图驾驶舱)
├── wiki/
│   ├── api/                 # API 设计文档
│   ├── business/            # 业务域(数据源、所有权规则)
│   ├── design/              # prototype.html(获批原型)
│   └── tech/                # 选型决策
├── .planning/               # 产品规划(source of truth)
└── README.md                # 本文件
```

## 开发约定

- 后端代码在 `code/backend`,前端在 `code/frontend`;所有命令用 `pnpm` 执行
- `pnpm-lock.yaml` 必须提交
- **三条架构铁律**(详见 CLAUDE.md / product-plan §3):非公开格式只进 Adapter 层;`~/.claude` 只读优先;终端存活会话只读不接管
- 服务严格绑定 `127.0.0.1`,不做鉴权也不暴露内网
- Agent 规则见 [CLAUDE.md](./CLAUDE.md)

## License

TBD(个人项目)
