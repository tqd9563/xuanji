### 修复
- **经验页面共享库 memory 标签显示问号**：共享库（`~/.claude/memory-shared/`）memory 的 `metadata.type: cross-project` 不在后端类型白名单（`user/feedback/project/reference`）内，被强制归为 `unknown`，导致「经验」页面对应条目的 tag 显示成 `?`；现将 `cross-project` 收编进白名单与前端标签映射，共享库 memory 正常显示 `cross-project` tag（新增专属 violet 配色），不再显示问号。frontmatter 缺失导致的问号（`type` 直接为 `undefined`）不在本次修复范围内，需要逐个补齐对应 memory 文件的 frontmatter。
