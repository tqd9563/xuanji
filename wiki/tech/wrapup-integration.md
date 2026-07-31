# wrapup 总结集成方案

> 状态:方案评审中(原型见 `wiki/design/prototype-wrapup.html`)
> 涉及三个子任务:① 派发页任务总结入口 ② 周报数据源改造 ③ 总结模块

## 0. 背景与数据源

`wrapup` skill 把一个已完成任务沉淀为一条总结,落盘在 `~/.claude/worklog/<YYYY>/<MM>/<YYYY-MM-DD>-<项目slug>-<任务slug>.md`,frontmatter 含 `date / project / task / branch / commits / mr / refs / status(merged|pending-merge|unresolved) / session / covers_until`,正文为 `问题 / 结论 / 排除项 / 已知残留 / 关键决策 / 涉及文件` 六段。顶层另有 `INDEX.md` 总索引(璇玑不依赖它,直接扫目录)。

架构定位:worklog 是 `~/.claude` 下的又一份只读数据源,与 skills / memory 同级。**璇玑只读不写**——生成动作由派发会话内的 Claude 执行 wrapup skill 完成,符合架构铁律 2(只读优先,写操作仅限既有两个例外)。

## 1. 派发页任务总结入口

**交互**:composer 底栏(`c-bar`)左侧新增「⚑ 任务总结」按钮,玉色 tint 描边高亮(与 hint 灰字形成层级差)。点击后:

1. 前端在 `Dispatch.tsx` 的 `submit()` 增加 `/wrapup` 拦截分支(沿用 `/clear`、`/resume` 的正则拦截范式);按钮点击等价于输入 `/wrapup` 回车。
2. 拦截后**不弹窗**,直接经 `d.send()` 向当前会话发送固定触发语:`执行 wrapup skill,把本会话刚完成的任务总结成一条记录;任务边界你先识别再向我确认`(skill 靠语义触发,SDK 无原生 slash;固定触发语保证命中率)。
3. skill 在会话流内正常执行(用户可看到 SKILL 工具卡与确认交互);会话正文即进度反馈,前端不需要额外状态机。
4. 总结生成后,后端 worklog watcher(见 §3)在下一次轮询发现新卡,前端 toast「已生成总结:<name>」并在侧栏「总结」计数 +1。

**快捷键 ⌘⏎**:按钮右侧标 mono 角标 `⌘⏎`,派发页内(含输入框聚焦)按下即触发,与点击等价。

⚠️ **必须同时改发送分支**:`Dispatch.tsx:722` 现为 `e.key === 'Enter' && !e.shiftKey`,**未排除 `metaKey`**——即今天 ⌘⏎ 就是发送。不补 `!e.metaKey` 会导致一次按键同时发送草稿并触发总结。改后裸 Enter 仍发送,Shift+Enter 仍换行,行为无损失。另需 `e.isComposing` 时不劫持(中文输入法候选窗回车)。

其余键位无冲突:项目内 ⌘M / ⌘D(`Dispatch.tsx:432-452`)、⌘N 与 ⌘+数字(`App.tsx:93-114`)均为字母/数字键;macOS 与浏览器在 textarea 内不占用 ⌘⏎。备选方案 ⌘S(Summary 助记,贴合现有字母键惯例),需 `preventDefault` 拦浏览器保存页面。

**可用性规则**:仅当前窗口绑定了会话且会话有至少一轮 result 时可点(快捷键同此判据,不可用时按键静默忽略);新会话空态下禁用(disabled 45% 透明)。不做「任务完成自动高亮提醒」——wrapup skill 自身明确禁止自动触发,任务边界只能语义判断,入口保持常驻即可。

**改动面**:仅 `code/frontend/src/views/Dispatch.tsx`(按钮 + ⌘⏎ 监听 + submit 拦截分支 + 发送分支补 `!e.metaKey`),后端零改动。

## 2. 周报数据源改造(卡片优先,流水兜底)

现状:`services/weekly-draft.ts` 的 `buildMaterial()` 以 history.jsonl ∪ 派发流水的逐条 prompt 聚合为材料,噪声大——周报得从「我当时怎么吩咐 AI」反推「实际做成了什么」。

**改造**:材料分两层——

- **主料:本周总结**。按窗口从 worklog adapter 取卡,进素材的是任务主题、状态、commits、问题、结论、已知残留、关键决策。卡片是人工确认过边界的任务级摘要,准确率天然高于从 prompt 流水反推。单卡各字段有字符封顶(结论 1200 / 问题 400 / 逐条 300),防一张极详实的卡挤掉同周其它卡。
- **兜底:未被卡片覆盖的活动**。已有卡片的项目只留统计并标注「不再展开」(同一件事不写两遍);**没有卡片的项目仍保留 prompt 样本**(封顶从 15 收紧到 6)——那是它们仅有的信号,砍掉等于周报直接漏掉这部分工作。此处与初版方案不同:初版写的是所有未覆盖活动都降级为纯统计,实现时改为保留精简样本,否则只 wrapup 了部分任务的周里,其余项目会在周报中凭空消失。项目 slug 与项目目录 basename 归一化后比对(下划线/短横线互转)。

**关于 token 消耗**:初版方案预期「更省」,但 2026-07-31 实测(4 条卡 / 38 条 prompt 的一周)素材反而从 5455 字符涨到 8714 字符——卡片写得详实而当周流水本就少。真正稳定的收益是**准确率**;省不省取决于「流水体量 / 卡片体量」的比值,流水重的周才会降。不要把本改造当成省钱手段宣传。

**prompt 改写**(`buildDraftPrompt`):指示模型以卡片为周报主体逐条改写(问题→结论→残留),统计摘要只用于补一段「其余活动」;`<material>` 注入防护沿用现状。

**降级路径**:本周 0 张卡时回退到现行为(全量流水材料),并在回顾页展示琥珀提示「本周暂无总结,周报将基于原始流水生成(准确率与消耗较差)」,引导先去派发页做任务总结。

**改动面**:`services/weekly-draft.ts`(取材与 prompt)、`services/weekly-review.ts`(聚合结果附 worklog 卡片计数)、前端 `Review.tsx`(数据源说明 + 本周总结面板 + 空卡提示)。

## 3. 总结模块

**后端**:
- `adapters/worklog.ts`:扫 `~/.claude/worklog/YYYY/MM/*.md`,解析 frontmatter + 正文分段(与 `scanMemories` 同构);解析失败的卡降级为「仅文件名 + 原文」不丢弃。路径根走 `config.claudeDir` 同级推导。
- `services/worklog.ts`:列表(按日期倒序,支持 project / status / 周区间 / 关键词过滤)、详情、周计数;可选 SQLite FTS 索引(与 memory 同法,可重建)。
- `routes.ts`:`GET /worklog`(query: week/project/status/q)、`GET /worklog/:name`。
- watcher:复用现有轮询节奏(前端 `usePoll` 60s 即可,不做 fs watch)。

**前端**:
- `App.tsx` `NAVS` 注册新视图 `worklog`(label「总结」,计数 = 本周卡数),`VIEW_IDS`、移动端归属「更多」二级页同步登记。
- `views/Worklog.tsx` 仿 `Skills.tsx` 范式:状态 filter-tabs(全部 / merged / pending-merge / unresolved)+ 项目筛选 + 搜索;列表按日期分组,行 = 日期(mono) + 项目芯片 + 任务标题 + 状态胶囊 + commits 数;`unresolved` 用琥珀胶囊(= 需要你回来处理)。点击行开右侧 Drawer:锚点 kv(分支 / commits / MR / session / covers_until)+ 六段正文渲染;session 锚点直连只读回放抽屉(复用定时任务「结果会话」同一词汇)。
- 全模块只读,无任何写操作。

## 4. 状态色语义(对齐 DESIGN.md)

| 状态 | 色 | 语义 |
|---|---|---|
| merged | 绿 pill-done | 彻底完事 |
| pending-merge | 蓝 pill-sched | 事实标注:等待合并,无需立刻处理 |
| unresolved | 琥珀 pill-blk | 需要你回来处理 |

## 5. 实施切分

1. `feature/worklog-module`:adapter + service + routes + 总结视图 + 导航(③,最大块,先行)
2. `feature/dispatch-wrapup-entry`:派发页按钮 + `/wrapup` 拦截 + 总结 toast(①,依赖 ③ 的 worklog API 做计数/toast,可堆叠或等 ③ 合并)
3. `feature/weekly-draft-from-cards`:周报取材改造 + 回顾页面板(②,依赖 ③ 的 adapter)

风险:worklog 卡片由 skill 生成,格式可能漂移——adapter 解析必须容错降级,不因单卡格式错误拖垮列表。
