### 修复
- **手机远程访问派发通道连接失败**：`/ws/dispatch` 与 `/ws` 的 WebSocket 连接协议前缀写死为 `ws://`，通过 HTTPS（如 Tailscale Serve 代理）访问时触发浏览器 mixed-content 拦截导致连接立即失败；现根据 `location.protocol` 动态选择 `wss://`/`ws://`，HTTPS 访问下派发与实时状态推送恢复正常。
