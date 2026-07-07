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

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| `~/.claude/jobs/<id>/` 无 json 配置 | 待确认 cron job 持久化位置 |

## 资源
- Agent SDK 查证:已派 claude-code-guide 子代理(后台),等待结果

## 视觉/浏览器发现
- 无
