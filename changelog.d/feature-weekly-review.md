### 新增
- **周回顾聚合 API**：`GET /api/weekly-review` 按「我发出的 prompt」口径（history.jsonl ∪ 璇玑派发流水）聚合窗口内活跃会话，项目→会话两级分组，含逐日热力、窗口内 token 成本与 git commit 题目；prompt 样本每会话封顶 30 条。
- **周报草稿生成**：`POST /api/weekly-review/draft` 复用派发通道跑一次性总结会话（看板可跟踪、完成待验收提醒、可续接迭代），素材只喂 prompt 流 + 会话名 + commits 不读会话全文，带防注入声明与 15 分钟超时；草稿存自有 SQLite（`weekly_drafts` 表），`GET /api/weekly-review/drafts` 供轮询。
- **「回顾」视图原型区块**：prototype.html 新增第 8 视图（周切换器、指标条、项目×日热力、项目分组会话列表可展开 prompt 原文、周报草稿面板含空态/生成中/完成三态），mock 数据取自真实聚合输出。

### 变更
- **extractUsage 支持时间窗上界**：新增可选 `untilMs`，开启时间过滤后无时间戳记录不再计入（原仅支持 `sinceMs` 下界）。
