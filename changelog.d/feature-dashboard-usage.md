### 新增
- **Token 用量时间范围与计量单位切换**：仪表盘用量模块支持在「今天 / 近一周」与「成本 $ / Token 量」之间切换，条长、数值与对比条同步换算；token 量按 k/M/B 分档（近一周量级会上到十亿档）。近一周按需拉取，首次统计期间显示「统计中…」并沿用今日数据垫底。
- **开发成本 vs multica 对比条**：用量模块顶部新增一条堆叠总览，给出开发项目与 multica workspaces 各自的成本/token 量与开发占比。此前 multica 被 `projectNoisePatterns` 静默过滤，界面上无从得知被排除掉多少。
- **`GET /api/usage?range=today|7d`**：用量报表接口支持窗口参数，非法值退回 today；`/api/usage/today` 保留为固定 today 口径的别名。响应新增 `range`、`since`、`noise`（被过滤目录的汇总）与每层的 `totalTokens`。

### 变更
- **仪表盘下半部布局**：左栏改为「最近活动」并拉通整栏（12 条 → 40 条，可视区封顶 60vh 后内部滚动），右栏是合并后的「Token 用量」模块（对比条 + 按项目条形图 + 7 日热力图）。原先独立占据一整行的「Token 成本」面板已并入该模块。

### 修复
- **同名项目在用量条形图里挤成一行**：项目展示名取编码目录末段，近一周窗口下 `skills`、`baize` 各有两个项目撞名，React key 冲突且用户分不清谁是谁。改为末段撞名时往前多带一段消歧（`antifraud-skills` / `yuiko-skills`），并用编码目录名作稳定 key。
- **narrate 会话误计入开发成本**：baize multica 任务里 `claude -p` 的叙述会话固定跑在 `.narrate-cwd` 目录下，此前按开发项目统计且以 `cwd` 之名高居近一周 top1（约 $233）。已将其并入 multica noise 桶（口径对齐 `cost_report.py` 的 Multica+Narrate），真实开发占比由 90% 修正为 57%。
