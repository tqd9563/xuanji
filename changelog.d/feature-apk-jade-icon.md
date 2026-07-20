### 变更
- **APK 版本号对齐**:Android 安装包版本号不再是脚手架默认的 `1.0`,`build.gradle` 改为动态读取 `code/mobile/package.json` 的 version(现为 `1.3.0`,versionCode 由 semver 计算得 `10300`),安装界面显示的版本与璇玑发版号保持一致,今后发版只需改 package.json。
- **APK 桌面图标**:Android 壳的启动器图标从旧样式换为与 web 侧栏/favicon 同源的璇玑玉璧剪影(玉色 `#bbc75f` 铺底 + 深色剪影,adaptive icon 前景/背景与传统图标全套重生成),开屏 splash 随图标同步更新;图标打进 APK 本体,**需重新安装 APK 才生效**(与前后端远程加载改动不同)。
