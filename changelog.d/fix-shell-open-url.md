### 修复
- **桌面壳(Xuanji.app)内链接点击仍无反应**:v1.2.0 已给输出链接加 `target="_blank"`,浏览器里可正常新标签打开;但 Pake/Tauri 壳在 Tauri IPC 未注入成功时(远程源 IPC 限制),注入脚本转交系统浏览器的调用失败,WKWebView 又吞掉新窗口请求,壳内点击依旧没反应。现在新增后端兜底:`POST /api/open-url`(仅放行 http/https,`execFile('open', [url])` 数组传参无注入面),前端检测到自己跑在壳内(WKWebView UA 特征 + 本机访问)且壳的 IPC 不可用时,点击链接改走该接口,由同机后端唤起系统默认浏览器;浏览器与远程访问路径行为不变。
