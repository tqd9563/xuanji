### 修复

- **派发会话补回 Claude Code 系统提示**：此前未向 Agent SDK 传 `systemPrompt`，SDK 只发一句兜底提示（模型自报首句为 "You are a Claude agent, built on Anthropic's Claude Agent SDK."），Claude Code 那套行为规范——工具使用纪律、代码风格、commit 约束、拒绝边界——在派发会话里全部缺席，行为与终端 CLI 不一致。现显式指定 `preset: 'claude_code'`，两者对齐；代价是每轮输入约多 6.5K token（实测 26.2K → 32.7K），走提示缓存后成本可忽略。
