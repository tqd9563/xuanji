### 新增
- **Markdown 输出色高亮原型**:wiki/design 新增 `prototype-md-colors.html`,在同一篇真实结构样例上并排对比四套标题/加粗着色方案(A 明度阶梯 / B 玉色锚点 / C 结构色带 / D OpenCode 风格散文色),带单选全宽查看;token 与 DESIGN.md 同源,供评审选定方向后再落代码。
- **Claude 输出配色(玉色锚点 / 散文色)**:设置 › 外观 › 阅读新增「输出配色」三档开关(默认 / 玉色锚点 / 散文色),默认保持现状(全白靠字重)。玉色锚点 = H1 用 jade 文字 + 左条、H2 加结构回响;散文色 = 标题与加粗用新增 `--prose-*` 低饱和 token(chroma ≤0.09,与状态色正交)。改 `<html data-md-color>` 由 CSS 接管,只覆写标题/加粗文字色,链接/代码/blockquote 不动;存本机 localStorage,手机与 Mac 各自一套。
### 变更
- **DESIGN.md 增补散文色词汇**:新增 `--prose-h1/h2/h3/strong` 四个 token + §2「Markdown 散文色」小节 +「散文色与状态色正交规则」Named Rule,圈定 prose 色只用于 markdown 正文标题/加粗、chroma 与状态色拉开档差、永不扩散到 UI 状态元素。
