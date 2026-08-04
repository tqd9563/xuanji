### 新增

- **璇玑玉璧品牌图标**：把侧栏左上角 brand-mark 的内联 SVG 剪影提取为独立矢量源 `code/frontend/public/brand-mark.svg`（玉色 #7F921D、透明背景、裁剪留白后剪影占画布 89%），并生成配套多尺寸 `favicon.ico`（16/32/48/64/128/256，PNG 压缩 25.7KB），为后续替换 index.html 内联 favicon 提供资源。

### 变更

- **favicon 替换**：index.html 的浏览器标签页图标从内联 data-URI SVG（旧写死玉色 #bbc75f）改为引用 `/favicon.ico`，颜色随之统一为 DESIGN.md `--jade` token 的标准 sRGB 转换值 #7F921D。
