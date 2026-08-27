# 验收面板(Acceptance Runbook)— 清单 schema 与模板数据结构

> 状态:方案设计中(尚未出原型)。
> 背景:派发会话开发完成后,验收需要切到终端手动起服务/灌数据,流程断在「璇玑明知道要跑什么命令,却让用户自己去跑」。本方案把「交付 → 验收」做成结构化闭环:项目沉淀**验收模板**,会话交付时**实例化清单**,璇玑渲染成可点击的验收面板。
> 设计讨论结论(2026-08-27):命令参数化是一等能力;预置 HTTP 请求覆盖 Postman 的验收用途(探索式调试仍留给 Postman);模板项目级复用,会话只做实例化;清单可选,简单项目自然退化为纯回复框。

## 0. 实体总览与归属

| 实体 | 是什么 | 存哪里 | 谁写 |
|------|--------|--------|------|
| `RunbookTemplate` | 项目级验收骨架(命令/参数定义/健康检查/收尾),一个项目可多个 | 璇玑 SQLite(自有数据,守铁律 2) | 用户在界面维护;可由 agent 归纳生成草稿,用户确认后激活 |
| `AcceptanceRunbook` | 一次交付的验收清单 = 模板引用 + 本次参数值 + 增量项 | worktree 内约定文件 `.xuanji/runbook.json`(见 §4) | 派发会话在交付前落盘 |
| `RunbookRun` | 面板上每次执行的运行态(pid/状态/日志/插值后命令) | 璇玑 SQLite | 璇玑后端 |

三者关系:模板是「稳定骨架」,实例是「骨架引用 + 本次填空」,运行态是「点了按钮之后的事」。模板改动不影响已交付实例(实例锁定模板版本)。

## 1. 清单项类型(RunbookItem,五种)

所有类型共享的基础字段:

```ts
interface ItemBase {
  id: string          // 清单内唯一,kebab-case,如 'seed-data'
  type: 'service' | 'command' | 'request' | 'link' | 'cleanup'
  title: string       // 面板按钮文案,如「灌入线上数据」
  description?: string
  origin: 'template' | 'session'  // 来源分级,决定执行前是否需确认(见 §6)
}
```

### 1.1 service — 长驻进程(dev server 等)

```ts
interface ServiceItem extends ItemBase {
  type: 'service'
  command: string                  // 如 './scripts/local_test.sh'
  cwd?: string                     // 相对 worktree 根,默认 '.'
  params?: ParamDef[]              // 见 §2
  env?: Record<string, string>
  readiness?:                      // 就绪判定,面板状态灯 running → ready 的依据
    | { kind: 'port'; port: number }
    | { kind: 'http'; url: string; timeoutSec?: number }
    | { kind: 'logPattern'; pattern: string }   // stdout 匹配到即就绪
  links?: { title: string; url: string }[]      // 就绪后可点的入口 URL
  stopCommand?: string             // 有优雅收尾脚本时用;缺省 = kill 整个进程组
}
```

- 面板呈现:按钮 + 状态灯(未启动/启动中/就绪/已退出/失败)+ 日志抽屉(tail 实时流)+ 就绪后点亮 links。
- 进程以**独立进程组** spawn,归属会话,不随璇玑后端重启死掉的问题后续在实现阶段决策(先接受随后端生命周期)。

### 1.2 command — 一次性命令(灌数据、造数、自测)

```ts
interface CommandItem extends ItemBase {
  type: 'command'
  command: string
  cwd?: string
  params?: ParamDef[]
  env?: Record<string, string>
  timeoutSec?: number              // 缺省 600
  dependsOn?: string[]             // 依赖的 item id,如 seed 依赖 service 就绪
}
```

- `dependsOn` 只做**软约束**:依赖项未就绪时按钮置灰并提示,不做自动编排(验收是人主导的流程,自动级联反而失控)。
- 面板呈现:按钮(+ 参数表单,见 §2)+ 输出折叠卡(复用工具输出卡范式)+ 退出码。

### 1.3 request — 预置 HTTP 请求(替代 Postman 的验收用途)

```ts
interface RequestItem extends ItemBase {
  type: 'request'
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  url: string                      // 支持参数占位,见 §2.3
  headers?: Record<string, string>
  body?: string                    // 原文;JSON 时面板做语法高亮
  params?: ParamDef[]              // url/body 中的占位参数
  expect?: string                  // 自然语言预期要点,给人看的,如「返回 code=0 且 items 非空」
  dependsOn?: string[]
}
```

- 面板呈现:方法 + URL + 可展开的 body → 「发送」→ 响应状态码 + JSON 格式化展示 + `expect` 并列显示供人工比对。
- **不做断言自动判定**:expect 是给人看的验收要点,不是测试框架。要自动断言的东西应该进 vitest,不进验收清单。

### 1.4 link — 纯验收入口 URL

```ts
interface LinkItem extends ItemBase {
  type: 'link'
  url: string
}
```

独立于 service 的 links 存在,用于「不由本面板启动的入口」(如线上对照页、文档)。

### 1.5 cleanup — 收尾命令

```ts
interface CleanupItem extends ItemBase {
  type: 'cleanup'
  command: string
  cwd?: string
  auto?: 'onResolve' | 'never'     // onResolve = 会话验收通过/归档时自动执行(缺省);never = 仅手动
}
```

## 2. 参数系统(ParamDef)

### 2.1 定义

```ts
interface ParamDef {
  key: string                      // 如 'start'
  label: string                    // 如「开始日期」
  type: 'string' | 'date' | 'number' | 'boolean' | 'enum'
  required?: boolean               // 缺省 false
  default?: string                 // 模板级默认;实例的 paramValues 覆盖它
  options?: string[]               // type=enum 时的可选值
  description?: string
  flag?: string                    // 如 '--start';给出则按 `<flag> <value>` 拼接
}
```

### 2.2 拼接规则(两种,择一)

1. **flag 追加**(常规路径):命令里不含该参数占位符时,按 `flag` 声明顺序追加到命令末尾。boolean 为 true 时只追加 flag 本身。
2. **占位插值**(显式路径):命令/URL/body 中出现 `{{key}}` 时,原地替换,不再追加。用于参数位置不在末尾、或 request 的 URL/body 场景。

两者按 item 内**逐参数**判定:出现占位符的参数走插值,其余走追加。

### 2.3 面板渲染

- `date` → 日期选择器;`enum` → 下拉;`boolean` → 开关;其余文本框。
- 值的优先级:用户本次输入 > 实例 `paramValues`(会话预填)> 模板 `default`。
- 执行前把**插值后的完整命令**展示在按钮下方(等宽小字)——用户点的是这条命令,不是一个黑盒按钮;这行也原样存进 `RunbookRun.resolvedCommand` 供审计。

### 2.4 安全边界

参数值只做**值级替换**,拼接前做 shell 转义(值整体作为单个 argv,不经 shell 解释)——参数框不能被用来注入 `; rm -rf`。需要自由命令的场景走 ad-hoc 输入框(二期,单独的确认机制),不借道参数。

## 3. 模板(RunbookTemplate)

```ts
interface RunbookTemplate {
  id: string
  project: string                  // 项目真实路径(与项目总览的项目标识同源)
  name: string                     // 如「标准验收」;一个项目可有多套(如「纯后端验收」)
  version: number                  // 每次编辑 +1;历史版本保留(实例按版本引用)
  status: 'draft' | 'active' | 'archived'
  source: 'user' | 'agent'         // agent 归纳生成的进 draft,用户界面确认后转 active
  items: RunbookItem[]             // origin 恒为 'template'
  createdAt: string
  updatedAt: string
}
```

要点:

- **版本锁定**:实例引用 `{templateId, version}`。模板后续编辑不回溯已交付的清单——验收的是交付那一刻的约定。
- **agent 起草流程**:用户在项目页点「生成验收模板」→ 派一个 headless 会话读 `scripts/`、`Makefile`、README 归纳出 draft → 用户在界面上核对每条命令后激活。draft 状态的模板不会被派发会话引用。
- 模板独立于派发流程可用:项目页可直接实例化一个「手工验收」面板(全用 default 参数),覆盖非派发的本地开发场景。

## 4. 实例(AcceptanceRunbook)与交付通道

```ts
interface AcceptanceRunbook {
  schemaVersion: 1
  templateRef?: { id: string; version: number }   // 可缺省:纯增量清单(项目无模板)
  paramValues?: Record<string, Record<string, string>>  // itemId → paramKey → 值,会话预填的本次默认
  omitItems?: string[]             // 本次用不上的模板项 id(面板隐藏,非删除)
  extraItems?: RunbookItem[]       // 本次特有项(origin='session'),典型:本次验收要打的 request
  notes?: string                   // 面板顶部的一句话验收指引
}
```

**交付通道:worktree 约定文件** `.xuanji/runbook.json`(worktree 根)。

- 派发会话在交付前落盘该文件;璇玑后端在会话进入「待验收」时读取一次并快照进 SQLite(此后 worktree 被清理也不影响面板回看)。
- 选文件而非消息内结构化块的理由:不受消息流式渲染/截断影响,可被会话反复修订(返工后更新清单重新交付),且解析点单一。
- 文件不存在 → 面板不出现,交付体验完全等于现状(antifraud_skills 类项目的退化路径,零负担)。
- `.xuanji/` 加入项目 `.gitignore` 建议清单(清单是交付物元数据,不进代码库)。
- 派发会话侧的产出约定(写进派发 system prompt / 项目 CLAUDE.md):有模板则引用模板 + 填 `paramValues`,不要重抄命令;request 类 extraItems 写清本次验收要打的具体请求与 expect。

## 5. 运行态(RunbookRun,璇玑自有)

```ts
interface RunbookRun {
  id: string
  sessionId: string                // 归属的派发会话
  itemId: string
  resolvedCommand: string          // 参数插值后的完整命令(审计与「点的是什么」的唯一事实)
  status: 'running' | 'ready' | 'exited' | 'failed' | 'stopped'
  pid?: number
  exitCode?: number
  startedAt: string
  endedAt?: string
  logPath: string                  // 输出落盘,面板 tail
}
```

- service 的存活进程全局可见:仪表盘「运行中的验收环境」挂件按会话分组列出,一键收尾——防止攒僵尸 preview 吃端口。
- 会话验收通过/归档时:先执行 `auto='onResolve'` 的 cleanup,再 kill 该会话名下仍存活的 service 进程组。

## 6. 安全模型(与防自斩铁律的衔接)

1. **来源分级确认**:`origin='template'` 的项 = 用户确认入库过,点击即执行;`origin='session'` 的项(extraItems)= agent 本次生成,**首次执行前弹完整命令确认**,同会话内二次执行免确认。
2. **执行层黑名单(机械兜底,不靠 prompt)**:插值后命令匹配 `restart.sh`、`launchctl … com.xuanji.backend`、kill 7777 监听进程、`pnpm launchd:*` 等模式时直接拒绝执行并明示原因——防自斩铁律在执行层落地,对模板项同样生效(防止模板被会话起草时夹带)。**拦截应前置到渲染时**:清单解析时即对每项命令跑一遍黑名单匹配,命中的项在面板上直接呈现「已拦截」态(红点 + 禁用按钮 + 拦截原因),不等用户点击才报错——「留给用户在终端执行」这类指引要在第一眼就可见。
3. **cwd 围栏**:执行 cwd 限定在该会话的 worktree 目录树内,清单里的相对 cwd 逃逸(`../`)拒绝。
4. **远程访问考量**:面板按钮在手机端(Tailscale)同样可用且体验良好;ad-hoc 自由命令输入框(二期)默认仅桌面端开放。

## 7. 三个标杆项目的清单示例

### baize_web(模板 + 参数化)

```jsonc
// RunbookTemplate items(节选)
[
  { "id": "dev-env", "type": "service", "title": "启动本地前后端",
    "command": "./scripts/local_test.sh",
    "readiness": { "kind": "http", "url": "http://localhost:8000/health" },
    "links": [{ "title": "本地前端", "url": "http://localhost:5173" }] },
  { "id": "seed", "type": "command", "title": "灌入线上数据",
    "command": "./scripts/local_seed.sh", "dependsOn": ["dev-env"],
    "params": [
      { "key": "env",   "label": "数据源", "type": "enum", "options": ["prod", "dev"],
        "default": "prod", "required": true, "flag": "--env" },
      { "key": "start", "label": "开始日期", "type": "date", "required": true, "flag": "--start" },
      { "key": "end",   "label": "结束日期", "type": "date", "required": true, "flag": "--end" } ] },
  { "id": "stop", "type": "cleanup", "title": "停止本地环境", "command": "./scripts/local_test.sh --stop" }
]
```

```jsonc
// 某次交付的 .xuanji/runbook.json
{ "schemaVersion": 1,
  "templateRef": { "id": "tpl_baize_std", "version": 3 },
  "paramValues": { "seed": { "start": "2026-08-20", "end": "2026-08-25" } },
  "notes": "重点看 8-22 当天 ROI 异动卡片的下钻是否带出素材维度" }
```

> `--env` 默认值必须显式写 `prod`:脚本自身的默认是 `dev`,而验收要看的是线上数据,漏了这个参数会拉到一份对不上的数据、把验收引向错误结论。这类**「脚本默认值 ≠ 验收所需值」的参数是模板最该固化的东西**——正是它让模板比每次手敲更可靠。
> 就绪判定的具体 URL、stop 方式以 baize_web 实际脚本为准,入库前由 agent 起草 + 用户核对。

### deep_baize(模板 + 本次预置请求)

```jsonc
// 模板:仅一条 service
[ { "id": "serve", "type": "service", "title": "启动本地服务", "command": "make serve",
    "readiness": { "kind": "port", "port": 8080 } } ]

// 实例 extraItems:本次验收要打的请求(origin=session,首次执行需确认)
{ "templateRef": { "id": "tpl_deepbaize_std", "version": 1 },
  "extraItems": [
    { "id": "req-funnel", "type": "request", "origin": "session",
      "title": "漏斗分析接口:新增 step 过滤", "method": "POST",
      "url": "http://localhost:8080/analyze_funnel_v2",
      "body": "{ \"game\": \"afk2\", \"steps\": [\"login\", \"pay\"] }",
      "expect": "返回 steps 数组含转化率字段,且 step 顺序与请求一致",
      "dependsOn": ["serve"] } ] }
```

### xuanji(隔离预览 + 布尔参数 + 黑名单,dogfooding)

```jsonc
// 模板:preview.sh 隔离验收环境(端口自动顺延,永不碰 :7777 常驻后端)
[
  { "id": "preview", "type": "service", "title": "启动隔离预览环境", "command": "./preview.sh",
    "readiness": { "kind": "http", "url": "http://127.0.0.1:37777/api/health" },
    "params": [ { "key": "keepdb", "label": "复用上轮快照", "type": "boolean", "flag": "--keep-db" } ],
    "links": [{ "title": "验收地址", "url": "http://localhost:35173" }] },
  { "id": "stop", "type": "cleanup", "title": "停止预览环境并清理临时数据", "command": "./preview.sh --stop" }
]
```

- 布尔参数渲染为勾选,勾选时才追加 flag(`./preview.sh` ↔ `./preview.sh --keep-db`);
- 端口顺延意味着 37777/35173 只是默认值——实现时就绪判定与 links 需消费 preview.sh 实际输出的端口(脚本已打印「验收地址」行,可解析),这是「links 支持运行时插值」的第一个真实用例;
- 若会话在 extraItems 里夹带「重启常驻后端使改动生效」(`./restart.sh`),按 §6.2 前置拦截,面板呈现「已拦截 + 防自斩原因 + 请在终端手动执行」——本项目是黑名单机制的第一个必然消费者。

### antifraud_skills(退化路径)

不落 `.xuanji/runbook.json`,或仅含一条自测 command。面板不出现或只有一个按钮,交付体验即现状。

## 8. 分期与本 schema 的覆盖范围

- **一期**(本 schema 全量):模板 CRUD + agent 起草、清单文件解析与快照、五种 item 的面板执行、参数表单、运行态与收尾、安全模型 §6 的 1-3。
- **二期**(不在本 schema 内):ad-hoc 命令输入框、仪表盘运行环境挂件的交互细化、request 的响应 diff 等增强。
- schema 演进走 `schemaVersion` 字段,adapter 侧向后兼容解析(未知字段忽略,未知 type 的 item 渲染为只读文本)。
