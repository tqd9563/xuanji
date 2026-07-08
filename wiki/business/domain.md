# 业务域

## 解决什么问题

个人 AI 生产规模化之后的碎片化巡检:数十个 Claude 会话(交互 + 后台)、40+ 技能、跨 8+ 项目的 memory、若干定时任务,散落在 `~/.claude/` 与多个终端窗口里。璇玑把它们聚合成一块常驻驾驶舱屏——扫一眼知道机群状态,blocked 的会话一分钟内被看到。

## 核心概念

| 概念 | 定义 | 数据来源 |
|---|---|---|
| 项目 Project | `~/.claude/projects/<encoded-cwd>/` 一个目录 = 一个工作目录;目录名是真实路径的 `/`→`-` 编码 | projects 目录 + history.jsonl |
| 会话 Session | 一次 Claude 对话,sessionId 全局唯一;kind = interactive(终端)/ background(daemon 托管) | `claude agents --json --all` + session jsonl |
| 会话状态 | running / blocked(等输入或审批)/ idle / done | agents JSON `state` 归一化 |
| 会话名 | 与终端 `/rename` 同源(agents JSON `name` / custom-title 事件) | 同上 |
| 技能 Skill | `SKILL.md` frontmatter 定义的能力单元;user(skills/)、disabled(skills-disabled/)、plugin(plugins/) | 技能目录扫描 |
| 经验 Memory | `projects/<proj>/memory/*.md`,frontmatter(name/description/type)+ Why/How + `[[链接]]` | memory 目录 |
| Token 成本 | input×单价 + cache_read×0.1×单价 + output×单价,按模型牌价折算 | session jsonl 的 assistant usage |

## 关键业务规则

1. **会话所有权**:终端存活的 interactive 会话只读展示不可接管;web 只 resume 自己派发的 / 已退出的 / blocked 的会话(M2 生效,M1 全只读)。
2. **只读优先**:M1 不写 `~/.claude` 任何字节;唯一未来例外是 memory 编辑与显式管理操作(见 CLAUDE.md 铁律 2)。
3. **噪音过滤**:项目扫描排除 `multica-workspaces-*` 临时目录与真实路径已不存在的目录,过滤数量对用户可见。
4. **数字带口径**:任何统计数字必须能回答"从哪来、怎么算"。
5. **降级不崩溃**:非公开格式解析失败一律降级(raw 展示 / 跳过计数),服务不 crash。

## 与官方产品的边界

会话总览做薄(官方 `claude agents` TUI 在快速演进),经验库、技能资产、Token 成本、定时生产线做厚——差异化在"个人生产资料层",不做"另一个会话列表"。
