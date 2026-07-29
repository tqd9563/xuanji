### 新增

- **1M 上下文模型**：派发台模型下拉新增 `claude-opus-5[1m]`（`/model opus-1m` 亦可切换），上下文窗口 1M；默认思考深度与 opus-5 一致为 low。

### 修复

- **Context 百分比按真实窗口计算**：此前分母写死 200K，换模型也不变；现改为读取 SDK `result` 消息里 `modelUsage[*].contextWindow` 的最大值（首个 result 到达前沿用 200K 兜底），1M 模型下不再虚高 5 倍。
