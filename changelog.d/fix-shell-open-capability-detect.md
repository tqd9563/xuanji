### 修复
- **桌面壳外链兜底不触发(UA 嗅探失效)**:上一版壳检测假设 Pake/Tauri WKWebView 的 UA 没有 `Safari/` 后缀,实际 Pake 壳 UA 伪装成完整 Safari(`…Version/26.0 Safari/605.1.15`),导致壳内点击链接时兜底逻辑恒不触发、依旧没反应。现改为**能力检测**:点击统一走 `window.open`,真浏览器返回窗口句柄(成功,并置 `opener=null` 防反向标签劫持);WKWebView 无新窗口代理时返回 `null`,此时且为本机访问才调后端 `/api/open-url` 唤起系统浏览器。修饰键点击(⌘/Ctrl/Shift/中键)保持浏览器默认行为;`stopPropagation` 阻断壳注入的 body 级监听避免双开。
