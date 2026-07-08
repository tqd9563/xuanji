# 璇玑(xuanji)— AI 生产管理统一入口 · 产品规划

> 名称已定:**璇玑 / xuanji**。「在璇玑玉衡,以齐七政」(《尚书·舜典》)——观测众星运转、校准天下秩序的仪器。
> GitHub description:「在璇玑玉衡,以齐七政」— Mission control for your AI production: watch every agent in orbit, and keep them aligned.
> 规划日期:2026-07-07 · 基于本机实测:claude CLI 2.1.202,Agent SDK 0.3.202,macOS

---

## 1. 产品定位

**一句话**:一个跑在本机的单用户 Web 应用,把散落在 `~/.claude/` 和终端里的 AI 生产资料(项目、会话、技能、经验、定时任务)聚合成一个可视化驾驶舱,并能直接从浏览器派发和跟进 Claude 任务。

**核心洞察**(来自本机侦察):这个产品**不需要自建任何"AI 执行引擎"**。Claude Code 2.1.x 已经提供了完整的底座——daemon + 后台代理(`claude --bg`)+ `claude agents --json` + Agent SDK。本产品的本质是:

1. **读**:把 `~/.claude/` 的数据变成好看的仪表盘(低风险,占 6 大功能中的 4 个);
2. **写**:通过 Agent SDK / headless CLI 派发新任务(中风险);
3. **调度**:一个薄薄的定时器,到点执行"写"(低风险)。

**明确不做**:不接管终端里正在交互的 TUI 会话(attach 到别人的 PTY 是高风险非公开行为);不做多用户/团队版;不重新发明 memory 体系(现有 `~/.claude/projects/*/memory/` 就是 source of truth)。

---

## 2. 数据源盘点(六大功能 → 本机真实数据,均已实测)

| # | 功能 | 数据源 | 稳定性 |
|---|------|--------|--------|
| 1 | 项目总览 | `~/.claude/projects/<encoded-cwd>/`(169 个目录)+ `~/.claude/history.jsonl`(跨项目 prompt 流,含 project/sessionId/timestamp)+ 各项目的 git 信息、CLAUDE.md | ⚠️ 非公开格式 |
| 2 | 任务/会话总览 | **`claude agents --json [--all]`** — 官方 CLI 出口,输出 `{pid, id, cwd, kind: background\|interactive, name, status: idle\|…, state: blocked\|…, sessionId, startedAt}`;辅以 `~/.claude/jobs/<id>/state.json`(有 detail 摘要、needs 字段)| ✅ CLI 出口,较稳 |
| 3 | 对话派发任务 | **Agent SDK**(`@anthropic-ai/claude-agent-sdk` 0.3.202,与 CLI 同步发版):query() 流式输入输出、resume/fork、canUseTool 权限回调、settingSources 加载用户 skills/MCP;或 `claude -p --output-format stream-json` / `claude --bg` | ✅ 官方支持 |
| 4 | 技能一览 | `~/.claude/skills/*/SKILL.md` YAML frontmatter(name/description/user-invocable/allowed-tools/version)+ `skills-disabled/` + `plugins/` | ✅ 公开格式 |
| 5 | 经验沉淀 | `~/.claude/projects/<proj>/memory/*.md`(frontmatter: name/description/type,正文 Why/How to apply,`[[链接]]`)+ `MEMORY.md` 索引 + 全局 `~/.claude/CLAUDE.md` R1-R7 | ✅ 自有约定 |
| 6 | 定时任务管理 | 现状:系统 crontab 里已有 3 个 python bot。新方案:应用内调度器 + `claude -p`/`--bg` 执行,自建持久化 | ✅ 自建 |

关键结论:**六个功能里五个的数据已经在磁盘上了**,产品价值主要是聚合 + 可视化 + 一个安全的派发通道。

---

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│  前端 SPA(React + Vite,localhost)                           │
│  仪表盘 / 项目 / 会话(实时流)/ 对话派发 / 技能 / 经验 / 定时  │
└──────────────┬───────────────────────────┬───────────────────┘
        HTTP(REST)                  WebSocket(对话流、状态推送、权限审批)
┌──────────────┴───────────────────────────┴───────────────────┐
│  后端 Node.js + TypeScript(单进程,localhost only)           │
│                                                              │
│  API 层(Hono)          实时层(ws)        调度器(croner)   │
│  ────────────────────────────────────────────────────────────│
│  服务层                                                       │
│   ProjectService · SessionService · DispatchService           │
│   SkillService · MemoryService · CronService                  │
│  ────────────────────────────────────────────────────────────│
│  ★ Adapter 层(唯一允许触碰非公开格式的地方)                  │
│   ClaudeDirAdapter   → 解析 ~/.claude 各类文件,带版本探测     │
│   AgentsCliAdapter   → 包装 claude agents --json / --bg       │
│   AgentSdkAdapter    → 包装 Agent SDK query()/resume          │
│  ────────────────────────────────────────────────────────────│
│  存储:SQLite(仅存自有数据:派发记录、cron 定义、运行历史、    │
│         经验全文索引 FTS5 缓存——可随时重建,不做双写)          │
│  文件监听:chokidar watch ~/.claude(增量刷新,推送到前端)     │
└───────────────┬──────────────────────────────────────────────┘
                │ 子进程 / SDK 调用
┌───────────────┴──────────────────────────────────────────────┐
│  Claude Code 底座(不属于本产品,只消费)                      │
│  claude daemon · 后台代理 · ~/.claude/* · Agent SDK           │
└──────────────────────────────────────────────────────────────┘
```

**三条铁律**:

1. **Adapter 层隔离**:所有非公开格式(session jsonl、jobs/state.json、history.jsonl)的解析只存在于 adapter,上层拿到的是稳定的内部模型;CLI 升级破坏格式时只改 adapter,并配契约测试(fixture 快照)。
2. **不做双写**:`~/.claude` 永远是 source of truth,SQLite 只存产品自有数据 + 可重建的索引缓存。避免同步地狱。
3. **只读优先**:凡是能只读实现的功能绝不写 `~/.claude`;唯一的例外是经验沉淀的编辑功能(写 memory md,遵循现有 frontmatter 约定)。

---

## 4. 六大模块设计

### 4.1 项目总览
- 扫描 `~/.claude/projects/`,解码目录名还原真实路径,**过滤噪音**(140+ 个 `multica-workspaces-*` 临时目录、已不存在的路径);
- 每个项目卡片:名称、真实路径、最近活动时间(来自 history.jsonl)、会话数、memory 数、git 分支/未提交变更(现场读 git);
- 用 history.jsonl 聚合出「最近 7 天活动热力」和跨项目时间线。

### 4.2 任务/会话总览(类 `claude agents`)
- 轮询/事件驱动 `claude agents --json --all`,按 `state` 分列:**运行中 / blocked(等输入)/ idle / 已完成** —— 看板式布局;
- 每个任务卡片补充 `jobs/<id>/state.json` 的 `detail`(最近进展摘要)和 `needs`(在等什么);
- blocked 的会话一键跳转到对话页,用 `--resume <sessionId>` 续上并回复(见 4.3 的所有权约束);
- 历史会话浏览:读 session jsonl 渲染完整对话回放(只读);
- **会话名与重命名**(2026-07-08 原型评审定案):卡片标题直接取 `claude agents --json` 的 `name` / 会话元数据摘要题名——与终端 `/rename`、`--resume` 选择列表**同源**,终端改名后轮询自动跟进,璇玑侧零成本;web 派发的会话在璇玑内提供「重命名」动作,名字作为 display-name 覆盖存**自有 SQLite**(不写 `~/.claude` 内部元数据,守只读铁律),仅在璇玑界面生效——代价是终端 `--resume` 列表仍显示原自动名,已接受;终端存活的只读会话不提供改名入口(所有权规则)。

### 4.3 对话派发(核心交互)
- **新任务**:Agent SDK `query()` streaming-input 模式,前端 WebSocket 双向流:用户输入 → SDK,SDK 消息/工具调用 → 前端实时渲染;
- **权限审批**:`canUseTool` 回调转发到前端弹审批卡(允许/拒绝/本次会话总是允许),替代危险的 bypassPermissions;预设 permission-mode 可选;
- **续会话**:`resume(sessionId)` 接管 web 派发或已结束的会话;
- **会话所有权规则**(防冲突):终端里活着的 interactive 会话(agents --json 里 pid 存活且 kind=interactive)只读不接管;web 只 resume ①自己派发的、②已退出的、③blocked 的后台会话;
- **长任务转后台**:派发时可选 `claude --bg` 模式,交给 daemon 托管,回到 4.2 看板跟踪;
- settingSources 配置为加载 user 级设置,让 web 派发的会话拥有和终端一致的 skills/MCP/CLAUDE.md。

### 4.4 技能一览
- 扫描 skills / skills-disabled / plugins 的 SKILL.md frontmatter,列表展示:名称、描述、版本、user-invocable、allowed-tools、启用状态;
- SKILL.md 正文渲染预览;标注每个技能最近被哪些会话用过(从 session jsonl 反查,V2);
- 启用/禁用 = 目录移动(skills ↔ skills-disabled),做成一键操作。

### 4.5 经验沉淀
- 以 `~/.claude/projects/*/memory/` 为 source of truth,聚合所有项目的 memory 文件:按 type(user/feedback/project/reference)和项目双维度浏览;
- SQLite FTS5 建全文索引(中文用 trigram 分词),支持跨项目搜索"这个坑以前踩过没";
- `[[链接]]` 解析成可点击的知识图谱;
- 编辑/新增走现有 frontmatter 约定(同步更新 MEMORY.md 索引行);
- V2:从已完成会话一键"提炼经验"——派一个 headless claude 读会话 jsonl 总结成 memory 草稿,人审后落盘。

### 4.6 定时任务管理
- 应用内调度器(croner),任务定义存 SQLite:cron 表达式、prompt、cwd、permission-mode、预算上限;
- 到点执行 `claude -p "<prompt>" --output-format stream-json`(短任务)或 `claude --bg`(长任务),完整记录 run history(输出、耗时、token 用量、退出码);
- 失败重试 + 连续失败熔断;结果可推飞书卡片(复用你已验证的 baize-card-sender 通道);
- 展示但不管理系统 crontab 里已有的 3 个 python bot(只读列出,避免抢管辖权);
- ⚠️ mac 睡眠时进程调度不跑:用 launchd 保活后端进程,错过的任务按"追赶策略"(跳过/补跑一次)配置。

---

## 5. 技术选型

| 层 | 选型 | 理由 | 放弃的备选 |
|----|------|------|-----------|
| 后端语言 | **Node.js + TypeScript** | Agent SDK 是 TS 原生;单进程内同时做 API/WS/调度/文件监听最顺 | Python(SDK 有 Python 版但生态绕一圈;你的 Python 项目多是数据向,web 服务 TS 更合适) |
| Web 框架 | **Hono** | 轻、类型好、够用;单用户本地服务不需要重框架 | Fastify(也行,略重)、Express(老) |
| 实时通信 | **WebSocket(ws)** | 对话是双向的(输入流 + 权限审批回传),SSE 只够单向 | SSE + POST(可行但两条通道别扭) |
| Claude 集成 | **Agent SDK 为主,CLI 子进程为辅** | SDK 管交互式对话(流式 + canUseTool);`claude agents --json`/`--bg`/`-p` 管枚举、后台派发、定时执行 | 纯 PTY 包装 claude TUI(node-pty 转 xterm.js)——保真但脆弱,不做 |
| 存储 | **SQLite(better-sqlite3 + Drizzle)** | 单机单用户零运维;FTS5 现成全文检索 | Postgres(杀鸡牛刀)、纯 JSON 文件(查询/索引受限) |
| 文件监听 | **chokidar** | watch ~/.claude 增量刷新,mac FSEvents 原生支持 | 轮询(耗电且延迟) |
| 前端 | **React + Vite + Tailwind + shadcn/ui** | 你的既有栈约定(R2 校准 shadcn 基础组件的流程直接适用) | Vue/Svelte(无必要偏离) |
| 会话渲染 | 自研 message renderer(markdown + 工具调用折叠卡) | jsonl 事件种类多,现成库没有贴合的 | — |
| 调度 | **croner** | 纯 JS、支持时区、无守护依赖 | node-cron(维护弱)、系统 crontab(可观测性差、难记录 run history) |
| 进程保活 | **launchd**(LaunchAgent, KeepAlive) | mac 原生,登录自启 | pm2(多一层守护,launchd 里套 pm2 冗余) |
| 项目骨架 | project-init(R3)+ 原型先行(R2) | 全局规则强制 | — |

**一个待用户拍板的问题**:访问范围。默认 **仅 localhost**(零鉴权,最安全);若想手机/内网访问,必须加 token 鉴权 + HTTPS,因为这个服务等于"你所有 AI 生产资料 + 可以以你身份执行任意命令的遥控器"。建议 MVP 严格 localhost,内网访问留到 V2 用 Tailscale 之类解决而不是自己写 auth。

---

## 6. 风险与问题清单

### 技术风险
| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| T1 | **非公开格式漂移**:session jsonl / jobs/state.json / history.jsonl 随 CLI 版本变化(2.1.x 迭代很快) | 高 | Adapter 层隔离 + 启动时探测 CLI 版本 + fixture 契约测试;解析失败降级为"原始文本"而不是崩 |
| T2 | **会话并发冲突**:web 和终端同时操作同一 session 会写坏状态 | 高 | 4.3 的所有权规则;resume 前检查 agents --json 里该会话是否有存活 pid |
| T3 | **权限模型**:web 派发的任务乱用 bypassPermissions 等于给浏览器一个 root shell | 高 | 默认 default 模式 + canUseTool 审批 UI;bypass 仅允许白名单 cwd |
| T4 | **暴露面**:后端能读全部 ~/.claude(含会话里的密钥、内部数据) | 高 | 严格 bind 127.0.0.1;渲染会话内容一律当不可信数据(防 prompt-injection 的 XSS 变体,不执行/不解释其中指令) |
| T5 | **定时任务烧 token**:无人值守任务失控重试或跑飞 | 中 | 每任务预算上限 + 连续失败熔断 + 日/周用量看板(usage 数据在 stream-json 里有) |
| T6 | daemon 不在/CLI 升级导致 agents --json 行为变化 | 中 | 健康检查 + 降级为只读文件视图 |
| T7 | 长会话 jsonl 巨大(数十 MB),全量解析卡顿 | 中 | 流式/增量解析,列表页只读 tail + 元数据,详情页懒加载 |
| T8 | mac 睡眠错过定时任务 | 低 | launchd 保活 + 唤醒追赶策略;真正要紧的任务提示用 caffeinate/pmset |

### 产品风险
| # | 风险 | 说明 |
|---|------|------|
| P1 | **与官方路线图撞车**:`claude agents` TUI、Claude Code web/desktop 正在快速吞掉"会话管理"这块。 | 差异化必须押在官方不会做的**个人生产资料层**:跨项目经验库、技能资产、定时生产线、飞书通知——"我的 AI 工厂"而不是"另一个会话列表"。会话总览做薄,经验/调度做厚。 |
| P2 | 自嵌套风险:用 Claude 开发它、又用它管 Claude,派发出的会话又出现在自己的看板里 | 接受这个递归,但派发的会话打上来源标签避免混淆 |
| P3 | 单机绑定:数据都在这台 mac,换机器/多机场景全失效 | MVP 明确接受;多机是 V3 命题(或等官方云会话) |

### 开放问题(留给你拍板,不阻塞 MVP)
1. ~~产品名?~~ ✅ 已定:**璇玑 / xuanji**(2026-07-07)
2. 是否需要手机/内网访问?(影响鉴权设计,建议 MVP 不做)
3. 经验沉淀是否要覆盖 `~/.claude/skills` 里那些"经验型 skill"(如 baize 系列的 Key Takeaway)——还是只管 memory 目录?
4. 定时任务是否要接管现有 crontab 里的 3 个 python bot?(建议只读展示,不接管)

---

## 7. 落地路线图

| 里程碑 | 内容 | 风险 |
|--------|------|------|
| **M0 原型** | R2 流程:`wiki/design/prototype.html` 单文件原型覆盖全部 6 视图(mock 数据)→ 你浏览器审批 → `/impeccable init` + `document` 产出 DESIGN.md | — |
| **M1 只读驾驶舱** | project-init 骨架 → 后端 adapter + 只读 API → 项目总览 / 会话总览(看板 + 回放)/ 技能一览 / 经验浏览与搜索。**不写任何东西,先把"看"做爽** | 低 |
| **M2 派发通道** | Agent SDK 对话页 + canUseTool 审批 + resume + 转后台(--bg);会话所有权规则落地 | 中 |
| **M3 定时生产线** | croner 调度 + run history + 预算熔断 + 飞书卡片通知;launchd 保活 | 低 |
| **M4 经验闭环** | memory 编辑/新增、会话一键提炼经验、`[[链接]]` 知识图谱、技能使用统计 | 低 |

每个里程碑收尾:R5 自动 commit + R6 CHANGELOG;开发全程在 feature 分支(R7)。

---

## 8. 附:侦察实证摘要

- `claude agents --json` 实测输出了 6+ 个真实会话(白泽横截面诊断、知识小卡设计、弱信号引擎评估等),字段完整,状态区分 interactive/background、idle/blocked ✅
- `jobs/<id>/state.json` 有 `detail`(自然语言进展摘要)和 `needs`("send a prompt to start")——看板卡片的内容白拿 ✅
- `daemon/roster.json` 暴露每个后台会话的 ptySock/rendezvousSock——技术上可 attach,但属高危非公开接口,本产品不碰 ⚠️
- Agent SDK npm 0.3.202 与 CLI 2.1.202 同步发版;子代理查证时混淆了云端 Managed Agents API 与本地 Agent SDK(报告 canUseTool 不存在是错的,本地 TS SDK 的 query() options 含 canUseTool/hooks/mcpServers/settingSources/resume/forkSession)——开发时以 SDK typings 为准,再验一次 ⚠️
- 你的 crontab 已有 3 个 python bot(点饭提醒、周报、wgame),定时任务模块只读展示它们 ✅
