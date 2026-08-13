### 新增

- **Weekly 限额模型级配比**：派发页状态条的 Weekly 用量条并为双轨芯片——上轨仍是 all models 周限额，下轨新增当前模型桶（如 Fable）的独立周利用率，两轨共用同一道时间刻度与倒计时（两窗口本就同一重置时刻）。数据取自 Agent SDK usage 接口的 `model_scoped[]`（缺失时兜底 `seven_day_opus`）；服务端未下发模型级窗口时自动退回原单轨形态。
