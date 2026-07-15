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
  chart-1: "oklch(0.68 0.075 115)"
  chart-2: "oklch(0.65 0.065 300)"
  chart-3: "oklch(0.65 0.065 245)"
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
  pill-running:
    textColor: "{colors.jade}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  pill-blocked:
    textColor: "{colors.amber}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  pill-done:
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
---

# Design System: 璇玑 xuanji

## 1. Overview

**Creative North Star: "夜间观象台(The Night Observatory)"**

璇玑是深夜里常驻在深色终端旁边的一块驾驶舱屏。整套系统模拟观象台的视觉物理:近黑的底(带 0.006 微量玉色调,hue 120°)是夜空,数据是唯一发光的东西——玉色的运行脉冲、琥珀的等待信号、蓝色的完成回执。界面本身隐入黑暗,永远不与数据争夺注意力。色彩策略是 **Restrained**:玉色(品牌主色,取自「璇玑玉衡」)只出现在主操作、当前选中与运行态上,占任何一屏的比例不超过一成。

信息密度服务扫视:可变文案限行截断、全文在下钻层;层级靠 OKLCH 明度阶梯(ink 0.93 → muted 0.71 → faint 0.60)而不是颜色堆砌;高频路径全键盘可达(数字键切视图、方向键选卡、Space 进会话、← 返回),手感对齐 `claude agents` TUI。本系统明确拒绝:SaaS 营销风(渐变文字、玻璃拟态、hero-metric 大数字卡)、大面积亮白底、Grafana 式图表墙、通用 admin 模板感。

**Key Characteristics:**
- 近黑玉调底 + 明度三阶墨色层级,深夜环境零刺眼
- 状态色即语义(玉/琥珀/蓝/红),项目分类色锁明度转色相,两套色彩词汇互不越界
- 单一无衬线 UI 字族 + 等宽数据字族,实时数字一律表格数字
- 平面优先,深度靠色调分层;阴影只属于悬浮层(抽屉/菜单/toast)
- 动效只表状态,150–250ms,指数缓出,尊重 prefers-reduced-motion
- 壁纸为可选个性化层:默认关闭,开启后仍以暗色预设与低不透明度服从「数据是唯一主角」的底线

## 2. Colors

夜空底、墨色层、玉之品牌、四色状态、等明度分类——五套词汇各司其职。

### Primary
- **玉 Jade** (oklch(0.80 0.13 115)):品牌主色与「运行中」状态色。主按钮底色、当前导航项、焦点描边、键盘选中卡描边、运行脉冲点。配 **on-jade** (oklch(0.18 0.02 120)) 深色文字确保按钮对比。
- **沉玉 Jade-dim** (oklch(0.68 0.10 115)):主按钮 hover 态、用量指示条填充——玉的低亮度姿态。

### Secondary
- **琥珀 Amber** (oklch(0.78 0.14 80)):「等待输入/审批」专用。blocked 状态、needs 文案、审批卡边框、git 脏区计数、超阈值用量。它出现即意味着"需要你"。
- **信使蓝 Blue** (oklch(0.72 0.11 245)):「已完成/信息」。完成状态胶囊、未推送计数(↑n)、工作目录文字色。
- **紫 Violet** (oklch(0.73 0.11 300)):模型标识专用色(派发状态行的模型名)。
- **赤 Red** (oklch(0.68 0.19 25)):错误与熔断,以及危险操作按钮。全站最稀有的颜色,出现即事故。

### Neutral
- **夜空 bg** (oklch(0.145 0.006 120)):页面底。**surface-2** (oklch(0.165 0.007 120)):侧栏与聊天区等第二层。**surface** (oklch(0.185 0.008 120)):面板/卡片/输入框。**hover** (oklch(0.215 0.009 120)):悬停提亮。四层构成色调深度阶梯。
- **墨 ink** (oklch(0.93 0.008 110)):正文与数据主体。**muted** (oklch(0.71 0.015 110)):次要说明。**faint** (oklch(0.60 0.012 110)):元数据与占位——三阶封顶,不再细分。
- **线 line / line-soft** (oklch(0.27/0.225 ~0.01 120)):1px 边框与分隔,永不加粗充当强调。

### Chart Series
- **chart-1/2/3** (oklch(0.68 0.075 115) / oklch(0.65 0.065 300) / oklch(0.65 0.065 245)):堆叠图大面积填充专用(fable/opus/sonnet),比状态色低两档饱和,防大色块刺眼。图表永不直接使用状态色作系列色。

### Named Rules
**状态色即语义规则。** 玉=运行、琥珀=等待、蓝=完成/信息、红=错误/熔断。状态色只出现在表达状态的元素上,任何装饰性使用都被禁止;状态永远配文字标签,不允许 color-alone。

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
- **Body** (400, 0.875rem, line-height 1.6):正文与聊天内容,长文 `text-wrap: pretty`,行长 ≤68ch。
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

### 壁纸玻璃档(可选深度材质)
玻璃档为面板与悬浮层(sidebar / panel / drawer / composer / chat / toast / scard / dd-menu / notice / wall-pop)叠加 `backdrop-filter: blur(var(--wall-frost)) saturate(1.1)`,让壁纸透过面板并被柔化。这是全站唯一被批准的 backdrop 模糊用途,默认 `--wall-frost: 0`(纯透明、无磨砂),仅用户主动调高(0–24px)才出现。壁纸图层本身(`#wall`)固定于 `z-index: -1`,以 `--wall-opacity`(默认 0.4)透出、`--wall-blur`(默认 0px)柔化,永不参与文档流。

### Named Rules
**悬浮才有影规则。** 任何贴在文档流里的元素(卡片、面板、按钮)禁止 box-shadow;看到影子就意味着"这层悬浮着,点外面会收回去"。

**磨砂即选项规则。** backdrop 模糊只属于用户显式开启的壁纸玻璃档,默认值恒为 0;任何非壁纸场景把 backdrop-filter 当装饰使用都被禁止。

## 5. Components

组件性格:精密仪器的克制——形态安静,状态清晰,反馈即时(150ms)。

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
- **侧栏:** 226px 固定列,surface-2 底;项 8px 12px、6px 圆角、muted 字;hover 提亮,active 玉 tint 底 + 玉字 + 600 字重;计数徽章 mono 全圆角
- **窄屏(≤960px):** 侧栏转顶部横条,计数徽章隐藏
- **快捷键:** 数字 1–7 直切视图,按钮悬停提示对应键位

### 自绘下拉(Signature Component)
原生 select 弹层由 OS 绘制无法主题化,故一律自绘(实现层用 shadcn/ui Select):无边触发钮(mono 字,按语义着色——目录蓝/模型紫)+ 悬浮菜单(surface 底、1px line 边、10px 圆角、悬浮影),选中项玉色对勾,Esc/外点关闭,贴近屏底的向上弹出。

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

## 6. Do's and Don'ts

### Do:
- **Do** 用四层色调阶梯(bg 0.145 → surface-2 0.165 → surface 0.185 → hover 0.215)表达一切静态深度;影子只给悬浮层。
- **Do** 给每一个跳动的数字开 `tabular-nums`,给每一处机器输出(路径/id/命令/数字)用等宽字。
- **Do** 状态永远「色 + 文字标签」并行;图表永远配图例与悬停精确值。
- **Do** 新增项目分类色时沿用 oklch(0.78 0.12 H) 锁明度公式,从八色环顺序取色。
- **Do** 所有过渡 150–250ms、`cubic-bezier(0.22, 1, 0.36, 1)` 缓出,且只在状态变化时发生;提供 `prefers-reduced-motion` 瞬时降级。
- **Do** 可变长度文案(标题/摘要/命令)一律限行截断,全文放下钻层或悬停提示。
- **Do** 壁纸作为可选个性化层:默认关闭,开启后默认参数为不透明度 40% / 壁纸模糊 0 / 玻璃表面 30% / 磨砂 0;所有 `--wall-*` 参数用户可调、存 localStorage,永不写 `~/.claude`;预设一律暗色,新增预设须沿用暗色低饱和以守夜间底线。

### Don't:
- **Don't** 使用「SaaS 营销风」词汇:渐变文字、玻璃拟态、hero-metric 大数字卡、装饰性动效——这是工作台,不是落地页(PRODUCT.md 反例原文)。
- **Don't** 引入大面积亮白底:用户常年深色终端环境,白屏刺眼即失败(PRODUCT.md 反例原文)。
- **Don't** 堆「Grafana 式图表墙」:每个图表必须回答一个具体问题,否则删掉(PRODUCT.md 反例原文)。
- **Don't** 把状态色用作装饰或图表系列色;图表大面积填充只允许 chart-* 降饱和系列。
- **Don't** 使用 >1px 的彩色侧条(border-left 强调)、`background-clip: text` 渐变字,或把玻璃模糊当默认外观——全线禁止。玻璃拟态**仅**作为用户显式开启、默认关闭的壁纸玻璃档存在;`--wall-frost` 默认恒为 0,绝不把 backdrop 模糊塞进任何非壁纸场景当装饰。
- **Don't** 让任何贴流元素投影;看到 box-shadow 而不悬浮,即是缺陷。
- **Don't** 用原生 select 弹层/系统默认控件样式直接见人——组件词汇全站唯一,同一动作在两处长得不一样,其中一处就是错的。
