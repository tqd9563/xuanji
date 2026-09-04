### 修复
- **快捷键表里「切换视图」一行与后面的文字重叠**：那几行只读键位用了 `className="fixed"`，而 Tailwind v4 会扫描源码里出现的类名字符串按需生成工具类，于是凭空多出一条 `.fixed{position:fixed}` 压在自己的样式上，把该行从表格流里踢出去。类名改为带项目前缀的 `stg-fixed`。
- **新增测试守卫**：扫描源码里的 `className="…"` 与 `cn('…')` 字面量，禁止裸用 Tailwind 保留字（`fixed`/`absolute`/`flex`/`grid`/`hidden` 等），并对「工具类落在同名元素上本就无害」的情形（如 `<table className="table">`）豁免。
