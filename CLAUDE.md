# 璇玑(xuanji)项目 Agent 规则

> 本文件仅在本项目目录及其子目录内生效。

## 项目规则

### 第一输入源
- 动手做任何设计/开发前,先读 `.planning/xuanji/product-plan.md`(产品定位、架构、选型、风险、M0-M4 路线图)与 `.planning/xuanji/findings.md`(技术决策表)。规划文件是本项目的 source of truth。

### 技术栈(已定,勿改)
- **后端:Node.js + TypeScript + Hono + WebSocket(ws)。禁止使用 Python 搭建本项目后端。**
- 包管理:pnpm(pnpm-lock.yaml 必须提交);测试:vitest;lint:eslint + `tsc --noEmit`
- 存储:SQLite(better-sqlite3 + Drizzle),只存自有数据与可重建索引,`~/.claude` 永远是 source of truth,不做双写
- 前端:React + Vite + Tailwind + shadcn/ui
- Claude 集成:Agent SDK(`@anthropic-ai/claude-agent-sdk`)为主,`claude agents --json` / `--bg` / `-p` 子进程为辅

### project-init 适配约定
- 使用 project-init skill 时**只遵守结构不变量**:`code/backend` + `code/frontend`、`wiki/{api,business,design,tech}/`、README 要素、原型关卡、执行清单
- skill 中所有 Python/uv/FastAPI/pytest/ruff 细节替换为上述 Node 等价物,`.gitignore` 用 Node 版
- 项目 agent 规则文件用本文件(CLAUDE.md),不再另建 AGENTS.md

### 架构铁律(详见 product-plan.md §3)
1. 所有非公开格式(session jsonl、jobs/state.json、history.jsonl)的解析只允许存在于 Adapter 层
2. 只读优先:能只读实现的功能绝不写 `~/.claude`;例外仅二(2026-07-08 用户批准):① 经验沉淀模块写 memory md;② 用户在界面显式触发、带二次确认的管理操作(如技能启停 = 在 `skills/` 与 `skills-disabled/` 间移动技能目录,可逆且不改文件内容)
3. 会话所有权:终端存活的 interactive 会话只读不接管;web 只 resume 自己派发的/已退出的/blocked 的会话

### 远程访问鉴权的维护纪律
- 新增任何「会在办公笔记本上执行代码」的写路由(派发、定时任务、技能启停、打开外链、拉起子进程等),**必须同步加进 `code/backend/src/auth.ts` 的 `EXEC_WRITE_PATTERNS`**,否则远程模式下它会绕过二次口令闸门。这是 code review 的固定检查项。
- 口令与证书只放 `~/.xuanji/remote.env`(chmod 600),不进仓库、不进 launchd plist、不进前端任何存储。
- `scripts/ip-watch.sh` 与 `install-ip-watch.mjs` 会重启后端,属宿主级操作,**派发会话严禁执行**(防自斩铁律)。
- 部署细则见 `wiki/tech/remote-access.md`。方案与威胁模型文档只留在本机(不进仓库,已 gitignore)。

### 流程
- 前端未过原型关卡(prototype.html 获批 → `/impeccable document` 出 DESIGN.md)前,不写任何前端代码(全局 R2)
- 开发在 `feature/` 分支进行,不直接提交 main(全局 R7;仅文档类改动例外,遵循既有惯例)

### 交付前起验收环境(worktree 开发的收尾动作)
在 worktree 里完成开发、过完质量门(lint + `tsc --noEmit` + vitest + `pnpm build`)、准备交给用户验收时,**自动执行 `./preview.sh`**,并在交付说明里给出脚本打印的验收地址——用户点开浏览器即可验收,不必自己拼端口、起服务、想办法避开生产实例。

- 脚本起一套与生产完全隔离的环境:高位端口(默认 37777/35173,占用自动顺延、**永不绑 7777**)+ 宿主库的 sqlite 快照副本 + vite dev server。验收里的归档/挂起/改名等写操作落在快照上,**不回流生产库**,常驻后端也不受影响。
- 多个 worktree 可同时验收:端口各自顺延、临时数据按 worktree 目录名隔离,互不打架。
- 交付说明里一并给出收尾命令 `./preview.sh --stop`;`--keep-db` 可复用上轮快照(保留上次验收里的归档/挂起状态)。
- 访问用 `localhost` 而非 `127.0.0.1`——vite 可能只绑 IPv6。
- 本脚本对派发会话安全:只起新进程,不碰 7777 宿主后端,与下方「防自斩铁律」不冲突。但**部署生效仍靠 `restart.sh`,派发会话不得执行**。
- 纯后端/纯文档改动没有可看界面时可跳过本步,但要在交付说明里写明跳过原因。

### 派发会话防自斩铁律(2026-07-09 事故后新增,最高优先级)
- **环境变量 `XUANJI_DISPATCH=1` 的会话是璇玑后端的子进程**。此类会话**严禁**重启或杀死璇玑后端:不得执行 `launchctl kickstart/bootout … com.xuanji.backend`、不得 kill 7777 端口监听进程、不得跑 `pnpm launchd:install/uninstall`——后端是你的宿主,重启它 = 当场杀死你自己,任务中断且用户看到的会话凭空消失(2026-07-09 已实际发生两次)。
- 派发会话对后端改动的验证以 `tsc --noEmit` + eslint + vitest + `pnpm build` 为准;「重启后端使改动生效」这一步写进交付说明,**留给用户或非派发会话执行**。
- 在本仓库做代码修改的派发任务,开工前先建独立 git worktree(`git worktree add`)再切分支:多个会话共用同一工作树时,互相 checkout 会踩掉对方的未提交修改。

---

## 经验教训

<!-- 按日期累积本项目的关键教训:学到了什么、为什么重要。 -->
