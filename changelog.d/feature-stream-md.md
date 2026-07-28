### 变更

- **流式 markdown 渲染**：引入块级记忆化组件 StreamMd，流式期间实时渲染 markdown（`**bold**` 立刻变粗体），已完成块由 React.memo 缓存不重渲染，每帧解析成本从 O(n²) 降到 O(last_block)，同时修复卡顿
- **Scroll 性能**：scrollTo 合批到 requestAnimationFrame，消除长会话每帧重排
- **移除**：废弃的 `.md-plain` CSS 类及对应样式
