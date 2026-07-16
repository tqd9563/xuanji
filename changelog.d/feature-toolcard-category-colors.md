### 变更
- **工具调用卡片按类别着色**：会话回放/派发页的工具调用折叠卡(ToolCard)工具名不再统一显示为蓝色,改为按行为类别区分——Skill 独立玫色、Bash/BashOutput/KillShell 执行类松石色(与信息蓝拉开色相距离,避免混淆)、Edit/Write/NotebookEdit 写入类橙色、Read/Grep/Glob/LSP/WebFetch/WebSearch 读取类沿用蓝色、Task/TodoWrite 等编排类沿用紫色(与派发状态行模型名同族),`mcp__*` 与未知工具归中性色;出错状态仍优先显示红色。新增 DESIGN.md token `tool-skill`/`tool-exec`/`tool-write`,并同步刷新 `.impeccable/design.json` 侧车。
