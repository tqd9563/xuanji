# 技术栈与选型理由

> 完整决策记录见 `.planning/xuanji/product-plan.md` §5;此处为落地摘要。

## 后端

- **语言**:Node.js 20 + TypeScript(strict)。Agent SDK 是 TS 原生;单进程内同时做 API / WebSocket / 调度 / 文件监听最顺。**本项目禁止 Python 后端**(项目 CLAUDE.md 铁律)。
- **Web 框架**:Hono(@hono/node-server)。轻、类型好;单用户本地服务不需要重框架。
- **实时**:ws。对话是双向的(M2 输入流 + 权限审批回传),SSE 只够单向。
- **存储**:SQLite(better-sqlite3 + Drizzle)。只存自有数据与可重建索引(memory FTS5 缓存);`~/.claude` 永远是 source of truth,不做双写。
- **文件监听**:chokidar(浅层 watch history.jsonl / skills / jobs,变更广播到前端触发重取)。
- **Claude 集成**:`claude agents --json --all` 子进程枚举会话;M2 起用 `@anthropic-ai/claude-agent-sdk` 派发。

## 前端

- React 18 + Vite + Tailwind + shadcn/ui(全局 R2:基础组件先校准到根目录 DESIGN.md 的 token 再写业务组件)。
- 会话渲染为自研 message renderer(markdown + 工具调用折叠卡),jsonl 事件种类多,现成库不贴合。

## 工具链

- 包管理 pnpm 9(lock 文件提交);测试 vitest;lint eslint(typescript-eslint)+ `tsc --noEmit`。
- 开发运行 tsx watch;生产由 launchd 保活(M3)。

## 关键工程决策

| 决策 | 说明 |
|---|---|
| Adapter 层隔离 | session jsonl / jobs/state.json / history.jsonl 等非公开格式的解析只存在于 `src/adapters/`,上层拿稳定内部模型;配 fixture 契约测试,CLI 升级破坏格式时只改 adapter |
| 解析失败降级 | 未知事件类型渲染为原始文本(raw),坏行跳过计数,绝不 crash |
| 只读优先 | M1 零写入 `~/.claude`;技能启停等管理写操作按铁律例外②在 M2+ 实现(显式触发 + 二次确认) |
| 绑定 127.0.0.1 | 该服务等于"全部 AI 生产资料 + 可执行任意命令的遥控器",MVP 严格 localhost 零鉴权,不开内网 |
| 端口 7777 固定 | 便于 launchd 常驻与 Pake 桌面壳包装 |
