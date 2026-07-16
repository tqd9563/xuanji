### 新增
- **Android 原生壳工程**：新增 `code/mobile`(Capacitor)，把璇玑打包成真安装的 APK(应用名"璇玑"，包名 `com.xuanji.app`)，`WebView` 远程加载 Tailscale Serve 暴露的璇玑地址，随后端迭代自动更新、无需重新打包；解决了安卓端浏览器碎片化(Chrome 安全 DNS 拦截 `*.ts.net`、Via 等轻量浏览器不支持 PWA 安装)导致的远程访问体验不稳定问题。
