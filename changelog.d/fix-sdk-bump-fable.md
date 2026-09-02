### 修复
- **派发 Fable 5.1 报 400**：升级 `@anthropic-ai/claude-agent-sdk` 0.3.204 → 0.3.258。后端派发走的是 SDK 内嵌 CLI(2.1.204)而非系统 `claude`,旧版不认识 Fable 5.1,升级后派发不再报「version 2.1.251 or newer is required」。
