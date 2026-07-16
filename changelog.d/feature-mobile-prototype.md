### 新增
- **移动端设计规范**：DESIGN.md 与 `.impeccable/design.json` 合并进移动端词汇——新增「四四触控规则」（≥44px 命中区、hover 必有点按等价）、Bottom Sheet 与移动端触屏形态两个 Signature Component、底部 tab 栏/发送键/触控开关组件 token、`rounded.sheet=16px`、上滑影、mobile 430px 断点与移动端 Do/Don't；桌面词汇不变。
- **移动端原型**：新增 `wiki/design/prototype-mobile.html`——针对触屏重新设计信息架构的移动端单文件原型（mock 数据与桌面版同源）。会话看板由 4 列横滚改为顶部状态 tab + 单列卡片流；派发页改触屏优先（底部输入栏、44px 发送键、大按钮审批卡、会话设置 bottom sheet 取代终端式下拉行）；项目/技能/经验改单列卡片流；全局 ≥44px 触控目标、hover 全部改为点按/`:active` 反馈、底部 5-tab 拇指区导航、抽屉/下拉/模态统一为 bottom sheet、适配 safe-area 刘海与 Home 指示条。
- **移动端布局落地(≤430px)**：原型正式接入前端实现。新增底部 5-tab 拇指区导航(首页/会话/派发/定时/更多)+ 顶部标识条,项目/技能/经验/回顾收进「更多」二级菜单;会话看板改状态 tab(需要你/运行中/空闲/已完成)+ 单列卡片流,取代桌面 4×272px 横向滚动;项目/技能表格改单列卡片流;全站 Drawer/自绘下拉一律收敛为底部上滑 sheet(含 sheet 化专用背景层);全局触控目标 ≥44px、输入框字号 ≥16px 防 iOS 聚焦缩放、适配刘海与 Home 指示条 safe-area。新增 `useIsMobile`/`useMediaQuery` hook 与 `TabBar`/`MoreMenu` 组件;桌面布局与交互零改动,已过 `tsc --noEmit`/`eslint`/`vite build` 与真实后端数据的浏览器截图验证。

### 修复
- **派发页移动端状态条挤压**：会话标识(sess-ctx)与用量条(Context/Usage/Weekly)、agent 状态三段挤在同一行导致用量条被推出可视区、要横滑才看得见。移动端把会话标识挪进消息区顶部(随内容滚动),状态条独占一行只放用量条 + agent 状态;发送按钮在移动端改图标(44×44 方形触控区),不再是被「转后台」开关和提示文字挤扁到显示不全的文字按钮。桌面布局不变。
- **派发页在部分安卓内嵌浏览器里发送按钮被顶到底部导航条后面**：真机(超级 App 内置浏览器,非独立 Safari/Chrome)反馈发送按钮仍看不清,根因是该类 WebView 对 `100dvh` 支持缺失或失真,派发页高度计算 `calc()` 整体失效,内容撑爆容器把输入框挤到我们自己的底部 tab 栏后面。三层修复:① `.chat` 补上经典 flexbox 修复 `min-height: 0`,即使高度计算完全失效也不会撑爆父容器(已用 `height:auto` 强制模拟验证);② 派发页高度改用 `100vh → 100dvh → --vh` 三级递进兜底,后者覆盖前者;③ 新增 JS 用 `window.innerHeight` 实测写入 `--vh` CSS 变量(跨内核一致性远好于任何 CSS 视口单位,是此类问题的标准解法),随 resize/orientationchange 更新。
