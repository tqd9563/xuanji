### 修复

- **版本号**：左上角版本号改为构建时从 `package.json` 注入，不再硬编码。此前发版只改 package.json 与 CHANGELOG，界面一直停在 `v1.4.0`，实际版本已是 1.5.1。
