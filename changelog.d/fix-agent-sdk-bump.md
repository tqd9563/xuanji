### 修复

- **Fable 5.2 可派发**：Agent SDK 升到 0.3.321(自带 CLI 2.1.280 → 2.1.321),之前选 `claude-fable-5-2` 会报 400「version 2.1.290 or newer is required」,模型面板里也看不到它;现在面板会列出 Fable 5.2 / Sonnet 5.5 / Haiku 5.5,`fable` 别名指向 5.2,Fable 5.1 作为单独一行保留
- **模型目录缓存键**：启动预热原本拿系统 `claude --version` 判断缓存是否过期,而目录其实是 SDK 自带 CLI 报的,两者版本不一致时升级 SDK 后可能误判命中、继续显示旧目录;改按 SDK 自带 CLI 的版本判断
