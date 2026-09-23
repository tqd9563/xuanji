### 新增

- **模型目录**：派发页模型下拉、⌘M「切换模型」面板与设置页「默认模型」的候选改为读后端 `GET /api/models`——即 CLI `/model` 面板那份目录（别名、真实 id、显示名、思考档），由 Agent SDK `supportedModels()` 报告并落 meta 表。CLI 升级后重启后端即自动跟上（后端启动按 CLI 版本判断是否需要起一个 0 token 的空会话拉目录，每个派发会话 init 后也顺手刷新），不再需要手改前端；旧的写死清单只作后端还没拉到目录时的兜底。
- **手输模型 id**：`/model claude-opus-5` 这类目录里没有但仍可用的完整 id 直接生效并出现在选择器里；⌘M 面板 placeholder 提示可输入完整 id。

### 变更

- **模型选项值**：选择器与账户偏好里存的是目录行的值（如 `default` / `opus[1m]` / `sonnet`），会随 CLI 升级自动改指向；升级前存的完整 id（如 `claude-sonnet-5`）到货后自动归一到对应目录行，`default` 行发起会话时不传 model、交给 CLI 默认。
- **面板显示**：⌘M 面板左列改为 CLI 的显示名（Default (recommended) / Opus (1M context) / Fable…），右列为解析到的真实 id；下拉里的「(默认)」项由目录的 `default` 行取代。
