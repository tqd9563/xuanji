### 新增

- **打包脚本**：新增 `build-app.sh`，固化 Pake 打包命令（名称 Xuanji、1400x900、隐藏标题栏、加载 localhost:7777），并硬校验 Pake 版本为 2.6.1（3.x 会导致壳内白屏）。

### 变更

- **桌面壳图标**：macOS 应用图标从 Pake 默认图标换成璇玑品牌标记，由矢量 `brand-mark.svg` 渲染为透明底 `assets/xuanji.icns`（16→1024 全档），Dock 中的显示尺寸与 Excel 等系统应用一致。
