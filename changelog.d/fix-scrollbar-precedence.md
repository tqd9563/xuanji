### 修复
- **滚动条**：Chrome 里鼠标悬停时仍会展开成原生粗轨道（上一版把标准滚动条属性推到全局，触发 Chrome 「设了标准属性就忽略 `::-webkit-scrollbar`」的规则）。现在 Chromium/WebKit 只走自绘 6px 细条，标准属性仅给 Firefox。
