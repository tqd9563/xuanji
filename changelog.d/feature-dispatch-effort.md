### 新增

- **派发会话可指定思考深度**:派发页底部工具栏新增「思考」下拉(自动 / low / medium / high / xhigh / max),也可在输入框敲 `/effort low`(`/effort auto` 回到自动、`/effort` 查看当前值),选择记入 localStorage 下次沿用。该值经 WebSocket 透传到后端,作为 Agent SDK `query()` 的 `effort` 选项下发给 `claude` CLI 的 `--effort` 参数。**只在创建会话时生效**——SDK 的 `Query` 接口只有 `setModel()`、没有 `setEffort()`,已开始的会话无法中途改档,改动对下一个新会话生效(下拉与提示文案均已标注)。
- **opus-5 默认思考深度 low**:「自动」档按模型取默认值,当前仅 `claude-opus-5` 映射为 `low`(该模型思考本身很深,日常派发用 low 已够且更省时省额度);其余模型不下发 `effort`,沿用模型自身默认(通常 high)。非法档位在后端 `parseEffort` 白名单处被拦成「未指定」,不会把脏值灌进 SDK。
