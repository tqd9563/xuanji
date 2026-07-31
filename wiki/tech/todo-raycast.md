# 待办模块:数据模型与 Raycast 全局速记

## 为什么待办可以写盘

架构铁律 2 是「只读优先」,约束的对象是**他人格式的文件**(`~/.claude` 下的 session jsonl、
jobs/state.json、history.jsonl 等)。待办是纯粹的璇玑自有数据,不映射 `~/.claude` 任何文件,
和 `dispatches` / `scheduled_jobs` / `weekly_drafts` 同属自有 SQLite 表,因此正常读写,
不构成铁律例外。

## 数据模型

表 `todos`(`code/backend/src/storage/db.ts`):

| 字段 | 说明 |
|---|---|
| `title` | 一句话想法,上限 500 字(更长的属于 prompt,该直接进派发页) |
| `cwd` / `project` | 项目绝对路径与末段短名;未指定为 `null`,开工时再选 |
| `status` | `open` → `doing`(已开工,挂上会话)→ `done` |
| `session_id` | 开工后绑定的派发会话,可直连只读回放 |
| `started_at` / `done_at` | 状态流转时间戳,回退到 `open` 时清空 |
| `source` | `web`(界面)/ `external`(Raycast 等脚本),仅作展示 |

两条刻意的设计约束:

- **开工不自动发送**:待办内容只预填进 composer,发不发由人决定。半句话想法直接发出去,
  会话质量不高。
- **会话结束不自动完成**:`done` 永远由人手动勾。一次会话未必真把事做完,机器无从判断。
  `doing` 的回填时机是 SDK 分配出 `sessionId`(= 真的发出去了),所以「开工后又没发」
  不会污染待办状态。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/todos` | 全部待办,新建倒序 |
| POST | `/api/todos` | `{title, cwd?, source?}`,201 返回 `{todo}` |
| PATCH | `/api/todos/:id` | 改 `title` / `status` / `cwd` / `sessionId` |
| DELETE | `/api/todos/:id` | 删除 |

`cwd` 走**宽松匹配**(`services/todos.ts` 的 `resolveProject`):绝对路径直接采信,
否则按短名分层打分匹配已知项目目录(100 前缀 > 80 中段 > 60 子序列,`xj` → `xuanji`),
匹配不上返回 `null` 存「未指定」而**不报错**——外部速记的第一要务是把话记下来,归属可以事后补。
打分口径与前端 `lib/fuzzy.ts`(`/wd` 弹窗共用)一致,同一个词在两处不会给出不同答案。

## 界面入口

1. **待办模块**(侧栏「待办」):顶部速记行 + 状态过滤 + 按日期分组;行内「开工 ▶」跳派发页。
2. **⌘J 速记浮层**(任意视图):键路径 `⌘J → 打字 → Tab → 搜项目 → ↩ → ↩`,
   `⌘↩` 保存并立即开工。**这是页内快捷键,璇玑窗口没有焦点时不触发**。
   Firefox 的 `⌘J` 被「下载」占用会截走,Chrome / Safari 上空闲。
3. **仪表盘待办卡**:`dash-now` 之下、统计条之上,露前 5 条未完成;无未完成时整卡不渲染。

## Raycast 全局速记(真·全局热键)

网页拿不到操作系统级热键,真正的「在任何 App 里敲一下就记」必须由常驻原生进程注册。
璇玑后端本身通过 launchd 常驻在 `localhost:7777`,所以只要有个能发 HTTP 的壳就行 ——
Raycast Script Command 是成本最低的那个。

脚本已就位:`~/project/raycast-scripts/记待办.sh`(依赖 `jq` 做 JSON 转义,已安装)。

配置步骤:

1. Raycast → Settings → Extensions → 左下 `+` → **Add Script Directory** →
   选 `~/project/raycast-scripts`(若该目录已加过则跳过,脚本会自动出现)。
2. 在列表里找到 **记待办**,右侧 **Record Hotkey** 绑一个全局热键(避开 `⌘J`,
   那是璇玑页内的;`⌥Space` 系的组合比较安全)。
3. 之后在任何 App 里敲热键 → 打字 → 回车,`mode: compact` 会在角落闪一条
   「已记入璇玑待办(xuanji)」然后自动收起,不打断手上的事。

已知限制:Script Command 的参数框只支持 text 与写死选项的 dropdown,**没有动态模糊搜索下拉**,
所以项目只能手打短名(靠服务端宽松匹配兜住)。要完整的搜索体验需要写 Raycast Extension
(TypeScript + React),成本高一个量级,暂不做——大部分随手记的想法本来就属于当前主力项目,
或者还没想好归属。
