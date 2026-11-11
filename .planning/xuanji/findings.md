# 发现与决策

## 需求
- 统一 Web 入口管理个人 AI 生产,6 大功能:
  1. 项目总览 2. 任务/会话总览(分状态) 3. 对话派发任务 4. 技能一览 5. 经验沉淀 6. 定时任务管理

## 研究发现(本机侦察 2026-07-07)

### 本机环境
- claude CLI **2.1.202**,macOS(darwin),zsh
- `~/.claude/` 下关键目录:`projects/`(169 个项目目录)、`skills/`(~44 个技能)、`jobs/`、`tasks/`、`sessions/`、`daemon*`、`history.jsonl`、`plans/`、`transcripts/`、`file-history/`

### 功能 2(任务/会话总览)的数据源 — 已验证 ✅
- `claude agents --json` 直接输出活跃会话 JSON 数组:`{pid, id, cwd, kind: background|interactive, startedAt, sessionId, name, status: idle|…, state: blocked|…}`
- `--all` 含已完成会话;`--cwd <path>` 过滤;不需要 TTY,可编程调用
- `claude --bg/--background` 可直接派发后台 agent
- 存在 daemon(supervisor 进程,`daemon.status.json` 有 pid/workers)

### 会话/项目数据(功能 1)
- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`:逐行事件(mode / permission-mode / file-history-snapshot / user / assistant …),含完整对话
- `~/.claude/history.jsonl`:每条用户 prompt 一行 `{display, timestamp, project, sessionId}` — 跨项目活动流的现成数据源
- 注意:大量 `multica-workspaces-*` 噪音目录需要过滤;项目目录名是 cwd 的编码(`-` 替换 `/`)
- ⚠️ jsonl 格式是**非公开实现细节**,版本升级可能变;需要 adapter 层隔离

### 经验沉淀(功能 5)现状
- 已有体系:`~/.claude/projects/<proj>/memory/` 每个 fact 一个 md(frontmatter: name/description/type)+ `MEMORY.md` 索引
- 全局规则在 `~/.claude/CLAUDE.md`(R1-R7)

### 技能(功能 4)现状
- `~/.claude/skills/<name>/SKILL.md`,YAML frontmatter(name/description/user-invocable/allowed-tools/hooks/metadata.version)
- 另有 `skills-disabled/` 目录;插件技能在 `plugins/`

### 定时任务(功能 6)现状
- 本 harness 有 CronCreate/CronList/CronDelete 工具(daemon 驱动);`~/.claude/jobs/<id>/` 目前只见 tmp 子目录,持久化格式待确认
- 用户已有 `project/cronjob/`、n8n 使用经验

## 技术决策
| 决策 | 理由 |
|------|------|
| 会话总览用 `claude agents --json` 而非解析内部文件 | 官方 CLI 出口,稳定;不依赖非公开格式 |
| 读 jsonl/history 等内部格式必须隔离在 adapter 层 | 非公开格式,版本漂移风险 |
| project-init 部分遵守:结构不变量全保留,Python 细节换 Node 等价物 | skill 写死 "Backend is always Python + uv",与 xuanji 的 Node/TS 栈冲突;骨架(code/ + wiki 四目录 + README + 原型关卡 + checklist)与栈无关照办;uv→pnpm、FastAPI→Hono、pytest→vitest、ruff/mypy→eslint+tsc、gitignore 换 Node 版,lock 文件同样提交 |
| 项目 agent 规则文件用 CLAUDE.md 而非 skill 要求的 AGENTS.md | 全局 R3 优先 + 与既有项目一致;内容沿用 skill 的两段式模板(项目规则 + 经验教训) |
| 全局终端用 node-pty + xterm.js 起**用户自己的 zsh**(2026-09-24 原型获批) | 与 product-plan §技术选型「不做 PTY 包装 claude TUI」不冲突:这里是通用 shell,不 attach、不接管任何 claude 会话;启动方式照抄用户 Ghostty(`arch -arm64 /bin/zsh --login`),显式补 TERM/COLORTERM/LANG(launchd 环境只有 PATH/HOME);WebSocket 只接受本机直连,拒绝经 Tailscale serve 反代的请求;Ghostty 配置解析属非公开格式,隔离在 adapter 层 |
| 飞书中控:后端进程内桥接 + `lark-cli` 子进程(2026-11-11 原型获批) | 长连接由本机主动连飞书,后端仍只绑 127.0.0.1,不需要公网地址或 VPN。不引入飞书 SDK:凭证由 `lark-cli` 配置档(默认 `xuanji`)保管,璇玑不读不存 app_secret;收消息 / 卡片回调各起一个常驻 `event consume`,发 / 改卡片逐次调用(实测单次 1.1–1.6s,进度卡 ≥5s 一刷足够)。`lark-cli` 调用只在 `adapters/lark-cli.ts`。一个飞书应用只能有一个长连接接收方,故必须用璇玑专用机器人(实测与 feishu-claude 共用「傻梨」时第二个接收方被拒) |
| 飞书白名单用「绑定码」建立,不预置 open_id | open_id 按应用区分、仓库公开不能硬编码;设置页生成 10 分钟有效的 6 位码,在飞书单聊发 `/bind 码` 绑定,同时记下单聊 chat_id 供锁屏推送。owner 与 chat_id 存 meta 单独键,不进可被前端整体回写的 prefs |
| 飞书推送时机只看「Mac 是否锁屏」(用户 2026-11-11 选定) | 读 `ioreg -n Root -d1` 的 `CGSSessionScreenIsLocked`;从飞书发起的回合不看锁屏、始终回推。范围与事件复用「通知」分区的开关,不另设 |
| 飞书卡片按钮不靠回调 token 更新,直接 PATCH 消息 | 回调 token 30 分钟过期且限 2 次;PATCH `/im/v1/messages/:id`(卡片带 `update_multi`)实测可用且无时效,点旧卡片也能原地改成「已失效」。代价:无法弹飞书 toast,改为卡片内文案 |
| 飞书收消息不打表情回执 | 表情接口需额外申请 `im:message.reactions:write_only`;进度卡在 1–2s 内出现,本身就是回执,不为此多要权限 |

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| `~/.claude/jobs/<id>/` 无 json 配置 | 待确认 cron job 持久化位置 |

## 资源
- Agent SDK 查证:已派 claude-code-guide 子代理(后台),等待结果

## 视觉/浏览器发现
- 无
