### 修复

- **本地壁纸图片刷新后丢失**：本地图片改用 IndexedDB 存原始 Blob（不再转 base64 塞 localStorage），配额从约 5MB 提升到按磁盘比例的数百 MB+，大图不再触发「仅本次会话生效」降级，刷新后壁纸保留。`localStorage` 只留元数据（模式/图源/四参数），`src==='custom'` 时挂载后从 IndexedDB 异步读回；仍全程只存本机浏览器、不写 `~/.claude`。IndexedDB 不可用时降级为内存 dataURL 并提示仅当次会话生效。
