---
name: 璇玑 xuanji
description: 深色观象台风格的个人 AI 生产驾驶舱——近黑玉调底上的只读仪表与键盘优先派发台
colors:
  bg: "oklch(0.145 0.006 120)"
  surface: "oklch(0.185 0.008 120)"
  surface-2: "oklch(0.165 0.007 120)"
  hover: "oklch(0.215 0.009 120)"
  line: "oklch(0.27 0.010 120)"
  line-soft: "oklch(0.225 0.009 120)"
  ink: "oklch(0.93 0.008 110)"
  muted: "oklch(0.71 0.015 110)"
  faint: "oklch(0.60 0.012 110)"
  jade: "oklch(0.80 0.13 115)"
  jade-dim: "oklch(0.68 0.10 115)"
  on-jade: "oklch(0.18 0.02 120)"
  amber: "oklch(0.78 0.14 80)"
  blue: "oklch(0.72 0.11 245)"
  violet: "oklch(0.73 0.11 300)"
  red: "oklch(0.68 0.19 25)"
  green: "oklch(0.74 0.12 155)"
  chart-1: "oklch(0.68 0.075 115)"
  chart-2: "oklch(0.65 0.065 300)"
  chart-3: "oklch(0.65 0.065 245)"
  tool-skill: "oklch(0.78 0.12 345)"
  tool-exec: "oklch(0.78 0.13 180)"
  tool-write: "oklch(0.78 0.12 55)"
typography:
  display:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "1.0625rem"
    fontWeight: 500
    letterSpacing: "0.02em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Helvetica Neue, Microsoft YaHei, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Helvetica Neue, Microsoft YaHei, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Helvetica Neue, Microsoft YaHei, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Helvetica Neue, Microsoft YaHei, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
  data:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "10px"
  chip: "4px"
  pill: "99px"
  sheet: "16px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.jade}"
    textColor: "{colors.on-jade}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  button-primary-hover:
    backgroundColor: "{colors.jade-dim}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
  button-danger:
    textColor: "{colors.red}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
  button-sm:
    rounded: "{rounded.sm}"
    padding: "3px 10px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
  thinking-card-head:
    textColor: "{colors.faint}"
    rounded: "{rounded.sm}"
    padding: "5px 10px 5px 0"
  thinking-card-head-hover:
    textColor: "{colors.muted}"
  thinking-card-body:
    textColor: "{colors.faint}"
    padding: "4px 0 8px 16px"
  pill-running:
    textColor: "{colors.jade}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  pill-blocked:
    textColor: "{colors.amber}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  pill-review:
    textColor: "{colors.violet}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  pill-done:
    textColor: "{colors.green}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  pill-scheduled:
    textColor: "{colors.blue}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  pill-error:
    textColor: "{colors.red}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  tag:
    textColor: "{colors.muted}"
    rounded: "{rounded.chip}"
    padding: "0 6px"
  proj-chip:
    rounded: "{rounded.chip}"
    padding: "1.5px 8px"
  wallpaper-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "14px 16px 12px"
  modal:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "18px 20px 20px"
  brand-mark:
    textColor: "{colors.jade}"
    width: "48px"
    height: "48px"
  tab-bar:
    backgroundColor: "{colors.surface-2}"
    height: "58px"
  bottom-sheet:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.sheet}"
    padding: "14px"
  send-button:
    backgroundColor: "{colors.jade}"
    textColor: "{colors.on-jade}"
    rounded: "12px"
    width: "44px"
    height: "44px"
  switch-on:
    backgroundColor: "{colors.jade}"
    rounded: "{rounded.pill}"
    width: "46px"
    height: "28px"
  wrapup-btn:
    backgroundColor: "color-mix(in oklab, {colors.jade} 13%, transparent)"
    textColor: "{colors.jade}"
    rounded: "{rounded.sm}"
    padding: "4px 12px"
  wrapup-btn-hover:
    backgroundColor: "color-mix(in oklab, {colors.jade} 22%, transparent)"
  residue-block:
    backgroundColor: "color-mix(in oklab, {colors.amber} 14%, transparent)"
    textColor: "{colors.amber}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  todo-capture:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 6px 4px 16px"
  todo-go:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "3px 11px"
  todo-go-hover:
    backgroundColor: "color-mix(in oklab, {colors.jade} 13%, transparent)"
    textColor: "{colors.jade}"
  todo-palette:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    width: "min(560px, 92vw)"
  from-todo-banner:
    backgroundColor: "color-mix(in oklab, {colors.jade} 13%, transparent)"
    textColor: "{colors.jade}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
---

# Design System: 璇玑 xuanji

## 1. Overview

**Creative North Star: "夜间观象台(The Night Observatory)"**

璇玑是深夜里常驻在深色终端旁边的一块驾驶舱屏。整套系统模拟观象台的视觉物理:近黑的底(带 0.006 微量玉色调,hue 120°)是夜空,数据是唯一发光的东西——玉色的运行脉冲、琥珀的等待信号、蓝色的完成回执。界面本身隐入黑暗,永远不与数据争夺注意力。色彩策略是 **Restrained**:玉色(品牌主色,取自「璇玑玉衡」)只出现在主操作、当前选中与运行态上,占任何一屏的比例不超过一成。

信息密度服务扫视:可变文案限行截断、全文在下钻层;层级靠 OKLCH 明度阶梯(ink 0.93 → muted 0.71 → faint 0.60)而不是颜色堆砌;高频路径全键盘可达(数字键切视图、方向键选卡、Space 进会话、← 返回),手感对齐 `claude agents` TUI。本系统明确拒绝:SaaS 营销风(渐变文字、玻璃拟态、hero-metric 大数字卡)、大面积亮白底、Grafana 式图表墙、通用 admin 模板感。

**Key Characteristics:**
- 近黑玉调底 + 明度三阶墨色层级,深夜环境零刺眼
- 状态色即语义(玉/琥珀/紫/翠/蓝/红),项目分类色锁明度转色相,两套色彩词汇互不越界
- 单一无衬线 UI 字族 + 等宽数据字族,实时数字一律表格数字
- 平面优先,深度靠色调分层;阴影只属于悬浮层(抽屉/菜单/toast)
- 动效只表状态,150–250ms,指数缓出,尊重 prefers-reduced-motion
- 壁纸为可选个性化层:默认关闭,开启后仍以暗色预设与低不透明度服从「数据是唯一主角」的底线
- 移动端(≤430px)是「手持罗盘」形态:重新组织交互而非缩放像素——底部 5-tab 拇指区导航、看板改状态 tab + 单列卡片流、抽屉/下拉/模态统一收敛为 bottom sheet、一切触控目标 ≥44px、hover 语义全部转点按;信息架构与桌面一致,密度让位于可点性

## 2. Colors

夜空底、墨色层、玉之品牌、六色状态、等明度分类——五套词汇各司其职。

### Primary
- **玉 Jade** (oklch(0.80 0.13 115)):品牌主色与「运行中」状态色。主按钮底色、当前导航项、焦点描边、键盘选中卡描边、运行脉冲点。配 **on-jade** (oklch(0.18 0.02 120)) 深色文字确保按钮对比。
- **沉玉 Jade-dim** (oklch(0.68 0.10 115)):主按钮 hover 态、用量指示条填充——玉的低亮度姿态。

### Secondary
- **琥珀 Amber** (oklch(0.78 0.14 80)):「等待输入/审批」专用。blocked 状态、needs 文案、审批卡边框、git 脏区计数、超阈值用量、定时任务的「需审批/已错过」胶囊。它出现即意味着"需要你"。
- **翠 Green** (oklch(0.74 0.12 155)):「已完成」专属状态色。会话看板/派发结果/定时任务运行历史的完成状态胶囊(`.pill-done`),以及成功退出的运行记录。绿色出现即意味着"这件事彻底完事了,不需要你再看"。
- **信使蓝 Blue** (oklch(0.72 0.11 245)):纯「信息」,不再表完成。未推送计数(↑n)、工作目录文字色、自绘下拉里目录值的字色、定时任务「待执行」排程胶囊(`.pill-scheduled`)——它标注事实,不宣告状态已终结。
- **紫 Violet** (oklch(0.73 0.11 300)):模型/编排同族色(派发状态行的模型名、自绘下拉里模型值的字色;亦作 ToolCard 编排类工具的类别色——Task 派发的即是子 agent,与模型标识同源)。**兼任「验收中」状态色**(`.pill-review`、`.tag.t-susp` 已挂起标签):琥珀严格独占「等待输入」(会话卡住动不了、必须你回话),验收中是「跑完了等你判断」——两者紧迫度不同,必须一眼可分,故验收中另起色相而非共用琥珀。验收中的胶囊圆点不脉动,与运行/阻塞的活跃态拉开层级。
- **赤 Red** (oklch(0.68 0.19 25)):错误与熔断,以及危险操作按钮。全站最稀有的颜色,出现即事故。

### Neutral
- **夜空 bg** (oklch(0.145 0.006 120)):页面底。**surface-2** (oklch(0.165 0.007 120)):侧栏与聊天区等第二层。**surface** (oklch(0.185 0.008 120)):面板/卡片/输入框。**hover** (oklch(0.215 0.009 120)):悬停提亮。四层构成色调深度阶梯。
- **墨 ink** (oklch(0.93 0.008 110)):正文与数据主体。**muted** (oklch(0.71 0.015 110)):次要说明。**faint** (oklch(0.60 0.012 110)):元数据与占位——三阶封顶,不再细分。
- **线 line / line-soft** (oklch(0.27/0.225 ~0.01 120)):1px 边框与分隔,永不加粗充当强调。

### Chart Series
- **chart-1/2/3** (oklch(0.68 0.075 115) / oklch(0.65 0.065 300) / oklch(0.65 0.065 245)):堆叠图大面积填充专用(fable/opus/sonnet),比状态色低两档饱和,防大色块刺眼。图表永不直接使用状态色作系列色。

### ToolCard 工具类别色
回放/派发页里工具调用折叠卡(`.toolcard .tc-head .fn`)按「行为类别」而非逐工具上色,回答扫视时的真问题——agent 在做哪类事:
- **tool-skill** (oklch(0.78 0.12 345)):Skill / SlashCommand 独立记忆色,与其余类别拉开色相距离。
- **tool-exec** (oklch(0.78 0.13 180)):Bash / BashOutput / KillShell。刻意推至 H=180,与 --blue(245)相距 65°,0.75rem 等宽小字下仍可分——早期取 H=195 与蓝混淆不清,已废弃。
- **读取/检索**:Read / Grep / Glob / LSP / WebFetch / WebSearch 复用 **--blue**,不新增 token(WebFetch/WebSearch 若单列会与蓝在小字下不可分,并入读取类)。
- **tool-write** (oklch(0.78 0.12 55)):Edit / Write / NotebookEdit。
- **编排/规划**:Task / TodoWrite / EnterPlanMode / ExitPlanMode 复用 **--violet**(与模型标识同族,见上文 Named Rules 更新)。
- **其余(含 `mcp__*` 长尾与未知工具)**:muted 中性,不参与争色。
- `isError` 时一律红色内联覆盖,优先级高于类别色,与状态色语义一致。

### Named Rules
**状态色即语义规则。** 玉=运行、琥珀=等待、绿=完成、蓝=纯信息、红=错误/熔断。「已完成」与「信息」是两件事:前者是终结状态,必须绿色;后者是事实标注(路径、计数、目录),永远蓝色,两者不得混用同一色相。状态色只出现在表达状态的元素上,任何装饰性使用都被禁止;状态永远配文字标签,不允许 color-alone。

**等明度分类规则。** 项目分类色一律 oklch(0.78 0.12 H) 只转色相(八色环:115/245/300/195/345/55/160/270,避开红与琥珀语义区),按首次出现顺序分配并持久化。不同项目一眼可分,而整屏亮度纹丝不动。

**一成玉规则。** 玉色在任何一屏的覆盖面积 ≤10%。它的稀有就是它的层级。

**玻璃表面规则。** 仅当用户显式开启壁纸「玻璃」档时,`--surface`/`--surface-2` 才由 `--wall-surface`(默认 30%,范围 25–95%)经 `color-mix(… , transparent)` 重映射为半透明,surface-2 恒比 surface 低 6 个百分点。这是全站唯一允许 surface 透明的场景;默认(壁纸关闭或纯壁纸档)surface 永远不透明。

## 3. Typography

**Display Font:** 无(本系统没有 display 字体;最大字号即 1.25rem 的视图标题)
**Body Font:** 系统无衬线栈(-apple-system / PingFang SC / Microsoft YaHei)
**Label/Mono Font:** ui-monospace / SF Mono / Menlo / Consolas

**Character:** 一族无衬线包办全部 UI 文字,等宽字族专职承载"机器的话"——路径、id、分支、命令、token 数、时钟。两族分工即语义:看到等宽字就是可信数据。

### Hierarchy
- **Display / 时钟** (500, 1.0625rem, mono, letter-spacing 0.02em, `font-variant-numeric: tabular-nums`):仪表盘右上角实时时钟,表格数字保证秒跳不抖版。
- **Headline** (600, 1.25rem):每视图一个 h1,`text-wrap: balance`。
- **Title** (600, 0.875rem):面板头 h2 与卡片标题(0.8125rem)。
- **Body** (400, 0.875rem, line-height 1.6):正文与聊天内容,长文 `text-wrap: pretty`,行长 ≤68ch。移动端(≤430px)正文升半档至 0.9375rem(15px),输入控件一律 ≥1rem(16px)防 iOS 聚焦自动缩放。
- **Label** (600, 0.6875rem):状态胶囊、tag、图例、提示文字。
- **Data** (400, 0.75–0.8125rem, mono):内联 `.mono` 取 0.8em 相对缩放。

### Named Rules
**表格数字规则。** 一切会跳动的数字(时钟、token 计数、百分比)必须开 `tabular-nums`,数字变化不得引起横向抖动。

**两族分工规则。** UI 说人话用无衬线,机器说话用等宽;禁止引入第三字族,禁止 display 字体出现在任何标签、按钮或数据上。

## 4. Elevation

平面优先。静止的界面完全平坦:深度靠四层色调阶梯(bg → surface-2 → surface → hover)与 1px 边框表达,面板与卡片在夜空底上以"更亮一档"的方式浮现,不投影。阴影是悬浮层的专属特权——只有脱离文档流悬在内容之上的东西(回放抽屉、自绘下拉菜单、toast)才允许投影,且一律大模糊低透明度的环境影。

### Shadow Vocabulary
- **抽屉影** (`box-shadow: -12px 0 32px oklch(0.05 0 0 / 0.45)`):右侧回放抽屉。
- **悬浮影** (`box-shadow: 0 8px 24px oklch(0.05 0 0 / 0.5)`):下拉菜单与 toast。
- **上滑影** (`box-shadow: 0 -8px 32px oklch(0.05 0 0 / 0.5)`):移动端 bottom sheet——抽屉影的竖屏镜像,同属悬浮层特权。

### 壁纸玻璃档(可选深度材质)
玻璃档为面板与悬浮层(sidebar / panel / drawer / composer / chat / toast / scard / dd-menu / notice / wall-pop)叠加 `backdrop-filter: blur(var(--wall-frost)) saturate(1.1)`,让壁纸透过面板并被柔化。这是全站唯一被批准的 backdrop 模糊用途,默认 `--wall-frost: 0`(纯透明、无磨砂),仅用户主动调高(0–24px)才出现。壁纸图层本身(`#wall`)固定于 `z-index: -1`,以 `--wall-opacity`(默认 0.4)透出、`--wall-blur`(默认 0px)柔化,永不参与文档流。

### Named Rules
**悬浮才有影规则。** 任何贴在文档流里的元素(卡片、面板、按钮)禁止 box-shadow;看到影子就意味着"这层悬浮着,点外面会收回去"。

**磨砂即选项规则。** backdrop 模糊只属于用户显式开启的壁纸玻璃档,默认值恒为 0;任何非壁纸场景把 backdrop-filter 当装饰使用都被禁止。

## 5. Components

组件性格:精密仪器的克制——形态安静,状态清晰,反馈即时(150ms)。

**四四触控规则。** 移动端(pointer: coarse)一切可点元素的命中区 ≥44×44px——视觉尺寸可以更小(如 6px 状态点、28px 开关),但触控区必须用 padding 或伪元素扩到 44px。hover 不是交互前提:凡桌面依赖 hover 的信息(悬停提示、hover 现身按钮)在移动端必须有点按等价物(下钻 sheet、常驻显示或省略),按压反馈用 `:active` 提亮(hover 色)。

### Buttons
- **Shape:** 轻圆角(6px)
- **Primary:** 玉底 + 深色字(jade / on-jade),padding 6px 14px,字重 600;hover 转沉玉;active 下沉 1px
- **Secondary(默认 .btn):** surface 底 + 1px line 边;hover 提亮至 hover 色并加亮边框
- **Danger:** 透明底 + 红字 + 45% 红边;hover 填 15% 红 tint
- **Quiet:** 无边透明,muted 字;hover 现身
- **尺寸:** 默认与 sm(3px 10px, 0.75rem)两档;disabled 一律 45% 透明度并禁用位移

### Chips(状态胶囊 / 标签 / 项目芯片)
- **状态胶囊 .pill:** 全圆角(99px),0.6875rem 600 字,「13% 同色 tint 底 + 全饱和字色 + 6px currentColor 圆点」三件套;运行态圆点 2s 脉冲
- **中性标签 .tag:** 方角(4px),1px line 边,muted 字——后台/终端/只读等事实性标注
- **项目芯片 .proj-chip:** 方角(4px),分类色 16% tint 底 + 同色 mono 字,悬停提示完整路径

### Cards / Containers
- **Corner Style:** 面板与卡片 10px;卡片(.scard)内边距 12px 14px,面板头 12px 18px 加 1px line-soft 下分隔
- **Background:** surface 浮在 bg 上;hover 提亮至 hover 色并加亮边框
- **可变字段纪律:** 标题/路径单行省略,detail/needs 钳制两行(-webkit-line-clamp),全文走悬停提示与回放页
- **键盘选中:** 2px 玉色 outline(offset -1px)

### Inputs / Fields
- **Style:** surface 底,1px line 边,6px 圆角,padding 6px 12px;placeholder 用 muted(不再降级)
- **Focus:** 边框转玉色,无 glow;composer(多行输入容器)整体 focus-within 转玉边
- **全局焦点态:** `:focus-visible` 一律 2px 玉色 outline + 2px offset

### Navigation
- **品牌标(`.brand-mark`):** 侧栏顶部「璇玑玉璧」图形标,48px,单色剪影 `fill: currentColor` 继承玉色(`{colors.jade}`),与 token 同源联动、改色即生效。文字改为两行 lockup:「璇玑」单独一行(玉色、原 headline 尺寸),`xuanji · v1.0.0` 合并作 mono 小字副标题另起一行(中点分隔沿用 side-foot 区「claude CLI 2.1.202 · daemon 正常」同款写法)。浏览器 favicon 复用同一剪影(内联 SVG data URI,因跨文档取不到 CSS 变量,固定写死玉色 hex `#bbc75f`)。
- **侧栏:** 226px 固定列,surface-2 底;项 8px 12px、6px 圆角、muted 字;hover 提亮,active 玉 tint 底 + 玉字 + 600 字重;计数徽章 mono 全圆角
- **窄屏(≤960px):** 侧栏转顶部横条,品牌标保留、计数徽章隐藏
- **移动端(≤430px):** 导航沉底为 5-tab 拇指区栏(`.tabbar`:首页/会话/派发/定时/更多,surface-2 底 + 1px line-soft 上边线,高 58px + safe-area,active 玉字玉标);「会话」tab 挂琥珀徽章显示 blocked 数;项目/技能/经验/回顾收进「更多」二级页,顶栏出 ‹ 返回。顶栏与 tab 栏吸附时允许 backdrop blur 作滚动垫层——这是功能性模糊,不属玻璃拟态禁区
- **快捷键:** 数字 1–7 直切视图,按钮悬停提示对应键位;移动端无物理键盘,快捷键语义由 tab 栏与卡片大点击区承接

### 思考卡(Signature Component · 派发流内的模型推理)
- **性格:** 全站唯一一个「刻意不发光」的信息块。彩色是稀缺资源,已分配给工具卡函数名与用户消息底色;思考只用中性阶(faint 正文 / muted 悬停),永远落在助手正文之后的第二层级。
- **结构:** 无边框无底色,仅左侧 1px `{colors.line}` 竖线 + 16px 缩进构成轨道;头部一行 = 虚线圆环图标 + 「思考」标签(sans 11px/600)+ 耗时(mono 12px/400)+ `▾`。宽度与工具卡同为 68ch。
- **三态:**
  - *思考中(`.live`)*:默认展开逐字流出,头部禁用不可折叠,耗时位显示「进行中」,竖线 2.4s 呼吸、图标 3.6s 自转,尾随闪烁光标。
  - *收起(默认终态)*:模型转入正文的一刻自动坍缩为单行,耗时定格(如「25.5s」),可点开回看。
  - *展开*:body 显出;超过 1200 字符时限高 320px + 底部 56px 渐隐,附「展开全文」。
- **对比度纪律:** 正文与耗时均为 `{colors.faint}` 实色,实测 4.89:1 过 AA。耗时曾用 75% 透明度写法,实测仅 3.22:1——**层次由字体族/字重承担(mono 400 vs sans 600),不靠降透明度**。
- **不渲染的情形:** 模型未思考、或思考明文被服务端剥空时,不留任何占位(空卡片比没有卡片更糟)。历史会话回放一律不含思考卡。

### 自绘下拉(Signature Component)
原生 select 弹层由 OS 绘制无法主题化,故一律自绘(实现层用 shadcn/ui Select):无边触发钮(mono 字,按语义着色——目录蓝/模型紫)+ 悬浮菜单(surface 底、1px line 边、10px 圆角、悬浮影),选中项玉色对勾,Esc/外点关闭,贴近屏底的向上弹出。**模态内变体**(`.dd.down`):表单字段贴顶部而非屏底时,菜单改为向下弹出、触发钮补满字段宽度并现出 surface 底 + line 边框(而非无边贴文本),其余选中态/对勾/关闭逻辑与默认下拉完全一致——仅弹出方向与触发钮外观随上下文调整,组件词汇不分叉。

### 居中模态(Signature Component)
新建/编辑类表单(如新建定时任务)用居中模态而非侧滑抽屉:`.modal` surface 底、1px line 边、10px 圆角、悬浮影,从 `translate(-50%,-46%)` 缓入到 `-50%,-50%` 并淡入(180ms);背景复用全站统一的 `.backdrop`(55% 黑度暗化,不与抽屉共享同一实例,可独立开关);modal-head 吸顶、modal-foot 常驻取消/主操作。何时选它而非抽屉:抽屉承载「查看/回放」类只读或续接内容,模态承载「创建/编辑」类需要提交或取消的表单——二者不互相替代。

### 会话状态条(Signature Component)
派发页输入框上下各一条超轻仪表:上条左侧 Context/Usage/Weekly 三枚用量指示(52px 微型进度条 + mono 百分比,超阈值转琥珀),右侧 agent 实时状态(等待审批琥珀脉冲/工作玉色脉冲/空闲灰);下条终端式状态行(蓝色 cwd ⎇ 玉色分支 + zsh 风格 `!n ?n ↑n` + 紫色模型名)。

### 外观 · 壁纸(Signature Component)
侧栏底部入口按钮(`.wall-btn`,mono 态标签显示当前档位)向上弹出设置面板(`.wall-pop`:surface 底、10px 圆角、悬浮影、贴屏底 92px 上弹、Esc / 外点关闭)。三档模式 + 四个运行参数,全部经 `--wall-*` CSS 变量驱动,存 localStorage,永不写 `~/.claude`;本地大图(>1.5MB dataURL)仅当次会话生效不落盘。

**三档模式(`.filter-tabs` 分段):**
- **关闭:** 壁纸层隐藏,回到纯夜空底(默认)。
- **壁纸:** 壁纸透在主背景区,面板保持不透明——最保守,不改变任何面板可读性。
- **玻璃:** 面板转半透明毛玻璃,壁纸整体透出——仅此档启用 `--wall-surface` 与 `--wall-frost`。

**四个参数(滑杆,默认 40 / 0 / 30 / 0,均 `tabular-nums` 显示):**
- **不透明度** `--wall-opacity`(默认 40%,范围 5–50%):壁纸图层透出强度,始终生效。
- **模糊** `--wall-blur`(默认 0px,范围 0–24px):壁纸图层全局柔化,始终生效。
- **表面** `--wall-surface`(默认 30%,范围 25–95%):面板底色不透明度,仅玻璃档生效;调低即壁纸透进面板。
- **磨砂** `--wall-frost`(默认 0px,范围 0–24px):面板毛玻璃模糊强度,仅玻璃档生效;非玻璃档时对应滑杆置灰(`.is-off`)。

**图源:** 内置两个暗色 SVG 预设(星野=北斗缀夜空、山岚=层叠远山雾),支持本地图片与任意 URL;缩略图选中态玉色描边。**默认参数 40/0/30/0 是用户实测确认的舒适档,不得擅自更改。**

### Bottom Sheet(Signature Component · 移动端统一悬浮层)
移动端把桌面三种悬浮词汇(右侧抽屉、自绘下拉、居中模态)统一收敛为一种:底部上滑 sheet(`.sheet`:surface 底、1px line-soft 边、顶部 16px 圆角、上滑影、顶部 36×4px 抓手条、max-height 88dvh、底部 padding 含 safe-area)。回放/经验详情用普通高度,新建任务表单用全高;背景统一 `.backdrop`(55% 黑度),外点/Esc/✕ 关闭,220ms 指数缓出上滑。桌面自绘下拉在 sheet 内退化为**选项大行**(`.opt-row`:48px 高、mono 值按语义着色——目录蓝/模型紫、行尾玉色对勾单选),组件语义不变、形态随输入方式切换。**何时用 sheet、何时用页面**:临时上下文(回放、设置、确认、表单)用 sheet,持续任务空间(视图本身)用页面——sheet 关掉后你仍在原地。

### 移动端触屏形态(Signature Component)
- **会话看板:** 4 状态列改为吸顶分段控件(`.seg`:需要你/运行中/空闲/已完成,带 mono 计数,「需要你」非选中时挂琥珀脉冲点)+ 单列全宽卡片流;已完成默认收起近 5 条,「更早 n 条」虚线按钮展开。
- **派发页:** 触屏优先——底部输入栏(textarea 16px + 44×44px 玉色发送键)、审批卡大按钮化(允许/拒绝双列 + 总是允许整行,各 ≥44px)、桌面终端式状态行改为可横滑 `.ctx-chip` 胶囊行(目录蓝 ⎇ 分支玉 / 模型紫 / 权限 / 前后台),点任一胶囊开「会话设置」sheet;用量三仪表保留微缩形态,agent 状态钉住行尾永不被挤出。
- **项目/技能/经验:** 多列网格与表格一律改单列卡片流;技能启停用 46×28px 开关(`::before` 扩触控区至 44px),禁用走确认 sheet。

### 定时任务列表(Signature Component)
一次性与周期任务共用同一份折叠列表(`.cron-item`/`.cron-row`):行首状态胶囊覆盖全生命周期(待执行=蓝 `pill-scheduled`、运行中=玉脉冲、需审批/已错过=琥珀脉冲、已完成=绿、已熔断=红),行尾时钟(mono、tabular-nums)与相对时间(faint)。周期任务在折叠态额外插入**近 7 期状态点**(`.runline`,6px 圆点,绿/红/琥珀,左旧右新,悬停提示范围),不展开也能扫出好坏。展开后运行历史表(`.runs`)逐期一行,「结果会话」列直连只读回放抽屉——失败/审批中的任务在此看真实转录(工具调用、报错原文),而不是新开一个会话去问 Claude 发生了什么;source of truth 恒在 `~/.claude` 的 session jsonl。

### 任务总结入口(Signature Component · composer 底栏的收口按钮)
派发页输入框底栏左端的 `.wrapup-btn`(⚑ 任务总结 + mono 角标 `⌘⏎`):玉色 13% tint 底 + 40% 玉描边 + 玉字,与紧邻的 faint 灰字 hint 形成一眼可辨的层级差。它借用「导航 active / 主操作」那套玉色词汇,但**刻意不加脉冲、不加发光**——wrapup 是语义触发、禁止自动执行的动作,入口的价值在常驻可达,稀缺的玉色本身就是高亮(仍在一成玉规则内)。会话未开始时 45% 透明并禁用,提示语讲清为什么不可用而不是沉默。角标是「机器的话」用 mono 承载,不与按钮文字争字重;移动端无物理键盘,角标隐藏、命中区撑到 44px。

### 已知残留块(`.residue`)
任务总结详情抽屉顶部的琥珀块:14% 琥珀 tint 底 + 35% 琥珀描边,头部一行「已知残留 · N 条」。它是抽屉里唯一被提到锚点区之上的段落——一条总结的六段正文里,「已知残留」是唯一意味着**还需要你回来处理**的内容,与琥珀「它出现即意味着需要你」的语义完全对齐。卡片模板里写「无」是合法写法,渲染前必须过滤,否则会出现一个写着「无」的琥珀警示块——那是纯噪声。

### 总结列表(`.wl-item` / `.rvwl-item`)
「总结」模块按日期分组(mono 小字组头),行 = 项目芯片 + 任务主题(单行省略)+ commit 数(mono faint)+ 状态胶囊;状态色沿用既有语义,不新造词汇:已合并=绿 `pill-done`(彻底完事)、待合并=蓝 `pill-sched`(事实标注,无需立刻处理)、未解决=琥珀 `pill-blk` 带脉冲点(需要你回来处理)。回顾页的「本周总结」是同一词汇的紧凑变体(`.rvwl-item`,加日期列、去 commit 数),点击下钻到「总结」模块——**同一份详情不在两处各维护一套**,状态胶囊也直接复用同一个组件。

### 速记浮层(`.tp-box` · ⌘J 两段式捕获)
顶部居中、距顶 22vh —— Spotlight/Raycast 建立的肌肉记忆位置,呼出后视线零搜索,半透明遮罩表达「临时压在当前视图之上」;22vh 而非更高,是给下方项目下拉留出展开空间。结构是**两段一线**:标题输入(0.9375rem,比列表正文大一号,是本浮层的主角)+ 项目模糊搜索框。键路径必须闭合成直线 `⌘J → 打字 → Tab → 搜项目 → ↩ → ↩`,其中确认项目后焦点自动回到标题框,**最后一次 ↩ 永远是「保存」**——同一个键在同一个浮层里不能有两种含义。项目框未输入时先列「最近使用」5 条(高频路径连打字都省),`Tab`/`⇧Tab` 与 `↑↓` 等价并在候选内循环,`Esc` 退回标题框而非直接关闭。不指定项目是合法终态:临时想法经常还没想清归属,不该为此卡住记录本身。

### 待办列表(`.td-item`)与开工按钮(`.td-go`)
按创建日分组(mono 组头,与总结模块同一词汇),行 = 勾选框 + 内容(单行省略)+ 项目芯片 + 停留时长(mono faint)+ 状态胶囊 + 开工。状态色继续复用既有语义、不新造:待办=中性 `pill-idle`、进行中=玉 `pill-run` 带脉冲点、已完成=绿 `pill-done`。**停留时长比内容更该被看见**——一条待办放了几天没动,是收集箱里最有行动价值的信号,故与状态胶囊并列常驻。`.td-go` 默认中性描边,悬停才染玉:玉色是稀缺资源,一整列常亮就不再是重点。勾选框未完成时中性、悬停才透出绿意——完成是奖励,不是默认期待;删除按钮悬停行才浮现,避免破坏性动作常驻。

### 待办来源横幅(`.from-todo`)
派发页 composer 上方的玉色 tint 条,说明本次会话由哪条待办发起,右端 ✕ 解除关联。它承担一条产品约束的可见化:待办「开工」只把内容**预填**进输入框、**不自动发送**(半句话想法直接发出去质量不高),所以界面必须解释「这段文字是哪来的、发出去会发生什么」。同理,会话结束不自动勾完成——那是人的判断。

### 验收面板(Signature Component · `.runbook`)
派发页消息区与状态条之间的常驻工具条——它是验收**阶段**的工作台,不是一条消息,所以不进消息流,而是夹在对话与输入框之间:抬眼看产出、低头点命令、就地回「验收通过」,一屏闭合。头部用紫罗兰(`.rb-label` + 30% 紫描边)接住「待验收」的既有语义色(与 `.pill-rev` 同源),**面板内部随即回到中性**——状态色是稀缺资源,只留给状态灯。折叠头常驻一行摘要(`● N 个环境运行中` / `环境未启动`),因为「有没有东西还开着」是收起面板后唯一还需要知道的事。

状态灯(`.rb-dot`)沿用全局状态词汇、不新造:faint=未启动、琥珀脉动=执行中、玉=就绪/完成、muted=已退出、红=失败或拦截。每个可执行项在按钮下方**常驻插值后的完整命令**(mono faint,参数段染蓝标出「这段是你填的」)——用户点的是一条命令而不是一个黑盒按钮,这与「数据可信优先:数字必须带口径」是同一条原则的两种形态。参数按类型渲染成日期选择器/下拉/勾选框,改动实时重算上方命令行。

两类「不可点」必须一眼可分,故走两个正交通道:依赖未就绪是**整行降透明 + 按钮禁用**(`.dep-wait`,语义是「还不能」,上游就绪后自动解除);命中防自斩黑名单是**红点 + 红底原因条**(`.rb-blocked`,语义是「永远不能」,并写清请改在终端手动执行)。拦截在渲染时就判定完毕,不等用户点了才报错。会话生成(未经模板入库)的项挂紫色 `.rb-origin` 标,首次执行弹完整命令确认层(复用 `.confirm-mask`),同会话内二次执行免确认。

## 6. Do's and Don'ts

### Do:
- **Do** 用四层色调阶梯(bg 0.145 → surface-2 0.165 → surface 0.185 → hover 0.215)表达一切静态深度;影子只给悬浮层。
- **Do** 给每一个跳动的数字开 `tabular-nums`,给每一处机器输出(路径/id/命令/数字)用等宽字。
- **Do** 状态永远「色 + 文字标签」并行;图表永远配图例与悬停精确值。
- **Do** 新增项目分类色时沿用 oklch(0.78 0.12 H) 锁明度公式,从八色环顺序取色。
- **Do** 所有过渡 150–250ms、`cubic-bezier(0.22, 1, 0.36, 1)` 缓出,且只在状态变化时发生;提供 `prefers-reduced-motion` 瞬时降级。
- **Do** 可变长度文案(标题/摘要/命令)一律限行截断,全文放下钻层或悬停提示。
- **Do** 壁纸作为可选个性化层:默认关闭,开启后默认参数为不透明度 40% / 壁纸模糊 0 / 玻璃表面 30% / 磨砂 0;所有 `--wall-*` 参数用户可调、存 localStorage,永不写 `~/.claude`;预设一律暗色,新增预设须沿用暗色低饱和以守夜间底线。
- **Do** 移动端守四四触控规则:命中区 ≥44×44px、输入控件字号 ≥16px、`viewport-fit=cover` + `env(safe-area-inset-*)` 适配刘海与 Home 条;临时上下文一律 bottom sheet,持续任务空间一律页面。
- **Do** 渲染外部生成的 markdown 内容(总结卡正文、周报草稿、SKILL.md)一律走全站统一的 `Md` 组件——这些文本里的 `**粗体**` 与反引号是作者的真实表达,当纯文本贴出来就是满屏字面量星号。同理,抽屉 `.kv dd` 里的长 URL / 路径必须 `overflow-wrap: anywhere`,否则顶破右边界。
- **Do** 语义为「空」的占位文案(总结卡里写「无」的残留段)在渲染前过滤掉——一个写着「无」的琥珀警示块比不显示更糟,它把「不需要你」误报成「需要你」。

### Don't:
- **Don't** 使用「SaaS 营销风」词汇:渐变文字、玻璃拟态、hero-metric 大数字卡、装饰性动效——这是工作台,不是落地页(PRODUCT.md 反例原文)。
- **Don't** 引入大面积亮白底:用户常年深色终端环境,白屏刺眼即失败(PRODUCT.md 反例原文)。
- **Don't** 堆「Grafana 式图表墙」:每个图表必须回答一个具体问题,否则删掉(PRODUCT.md 反例原文)。
- **Don't** 把状态色用作装饰或图表系列色;图表大面积填充只允许 chart-* 降饱和系列。
- **Don't** 使用 >1px 的彩色侧条(border-left 强调)、`background-clip: text` 渐变字,或把玻璃模糊当默认外观——全线禁止。玻璃拟态**仅**作为用户显式开启、默认关闭的壁纸玻璃档存在;`--wall-frost` 默认恒为 0,绝不把 backdrop 模糊塞进任何非壁纸场景当装饰。
- **Don't** 让任何贴流元素投影;看到 box-shadow 而不悬浮,即是缺陷。
- **Don't** 用原生 select 弹层/系统默认控件样式直接见人——组件词汇全站唯一,同一动作在两处长得不一样,其中一处就是错的。
- **Don't** 把蓝色用作「已完成」的状态色——蓝色现在专指纯信息(路径/计数/目录),完成态一律绿色(`{colors.green}`);两者语义不同,不得因为都"看着积极"就混用同一色相。
- **Don't** 为失败/需审批的定时任务新开一个会话去问 Claude「发生了什么」——真实转录已经在 session jsonl 里,只读回放抽屉是唯一入口。
- **Don't** 用降透明度的办法制造次要层级——`color-mix(… 75%, transparent)` 之类写法把 12px 耗时文字压到 3.22:1(实测),掉出 AA。次要感一律由字体族、字重、字号承担,颜色只在 token 阶梯(ink → muted → faint)里选,选到 faint 就是底线。
- **Don't** 给思考块上色、加边框、加底色或让它发光——思考不是数据,不参与争色;凡看到思考块比同屏工具卡更抢眼,即是缺陷。
- **Don't** 在移动端用 hover 承载任何功能或信息,也不要把桌面多列网格/横滚看板直接缩放到窄屏——移动端形态是重新组织(状态 tab、单列流、sheet),不是等比缩小;凡一屏只能看到「一列半」的布局即是缺陷。
