### 新增
- **移动端设计规范**：DESIGN.md 与 `.impeccable/design.json` 合并进移动端词汇——新增「四四触控规则」（≥44px 命中区、hover 必有点按等价）、Bottom Sheet 与移动端触屏形态两个 Signature Component、底部 tab 栏/发送键/触控开关组件 token、`rounded.sheet=16px`、上滑影、mobile 430px 断点与移动端 Do/Don't；桌面词汇不变。
- **移动端原型**：新增 `wiki/design/prototype-mobile.html`——针对触屏重新设计信息架构的移动端单文件原型（mock 数据与桌面版同源）。会话看板由 4 列横滚改为顶部状态 tab + 单列卡片流；派发页改触屏优先（底部输入栏、44px 发送键、大按钮审批卡、会话设置 bottom sheet 取代终端式下拉行）；项目/技能/经验改单列卡片流；全局 ≥44px 触控目标、hover 全部改为点按/`:active` 反馈、底部 5-tab 拇指区导航、抽屉/下拉/模态统一为 bottom sheet、适配 safe-area 刘海与 Home 指示条。
