# Changelog

本文件记录璇玑(xuanji)项目的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- **M0 交互原型**:新增 `wiki/design/prototype.html` 单文件高保真原型,深色「观象台」主题(玉色品牌色,OKLCH),覆盖全部七个视图——仪表盘、项目总览、会话看板(含只读回放抽屉与降级事件展示)、对话派发(canUseTool 审批卡、转后台开关、--resume 续接)、技能一览(启停开关 + 详情抽屉)、经验沉淀(type/项目双维筛选 + [[链接]] 跳转)、定时任务(run history、熔断态、系统 crontab 只读区);mock 数据贴近本机侦察实况,关键交互可点,已通过 1440/760 双宽度截图验证。等待浏览器审批后进入 `/impeccable document` 出 DESIGN.md。
- **产品规划**:迁入完整产品规划文档(`.planning/xuanji/`),含产品定位、六大模块数据源盘点与设计、整体架构、技术选型、风险清单及 M0-M4 落地路线图;命名定为「璇玑」,取《尚书·舜典》「在璇玑玉衡,以齐七政」。
- **项目级 CLAUDE.md**:固化技术栈(Node/TS + Hono,明确禁止 Python 后端)、project-init 适配约定、三条架构铁律与流程规则,保证任何新开会话都继承正确上下文。

### 变更
- **M0 原型迭代(第三轮审批反馈)**:派发页改为终端式排版——用量指示(改名 Context/Usage/Weekly)移到输入框左上方、agent 实时状态右移,工作目录与 git 分支(玉色)/模型(蓝色)/权限模式移到输入框正下方状态行,顶部工具栏取消;仪表盘 Token 消耗面板改为项目级两层结构,点击项目行展开该项目内会话级排行,单条改为 input / cache read / output 三段堆叠条(同色相三档明度,output 最亮),图例入面板头,总量口径同步改为「in+out + cache read 另计」。
- **M0 原型迭代(第二轮审批反馈)**:派发页用量指示(上下文/5h/周限额)从顶栏移至会话窗口底部状态条,视线与输入框同区;状态条左侧新增 agent 实时状态指示(等待审批=琥珀、思考中/执行工具/回复生成中=玉色脉冲、空闲=灰),映射 SDK 流事件;顶栏新增所选工作目录的 git 分支(含未提交变更数,随目录切换联动)与模型选择器(默认 claude-fable-5)。
- **架构铁律 2 扩例外(用户批准)**:`~/.claude` 只读例外从「仅 memory md」扩为「memory md + 用户界面显式触发、带二次确认的管理操作」,首个适用场景为技能启停(移动技能目录,可逆)。
- **M0 原型迭代(第一轮审批反馈)**:会话看板列序改为「空闲 → 运行中 → 等待输入 → 已完成」;仪表盘新增「Token 消耗」面板(按任务聚合 session jsonl 的 usage 字段,今日/本周合计 + Top 任务单色条图);派发页顶栏新增上下文 / 5h / 周限额三枚用量指示(对齐 claude-hud 能力);项目视图 mock 补入 baize-web 与 antifraud-skills(此前缺失系 mock 数据未覆盖,非过滤逻辑问题),过滤说明改为明确的 multica-workspaces-* 规则并注明可配置;技能页新增开关语义说明条(关闭 = 移入 skills-disabled/,显式写操作需二次确认)。
- **脚手架约定**:明确 project-init skill 的适配方式——结构不变量(code/ + wiki 四目录 + README + 原型关卡)全保留,Python 专属细节替换为 Node 等价物(uv→pnpm、FastAPI→Hono、pytest→vitest);项目 agent 规则文件按全局 R3 用 CLAUDE.md 而非 AGENTS.md。
