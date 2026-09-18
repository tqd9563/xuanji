### 修复

- **派发看板状态**：发布过 Artifact 的会话不再永远停在「进行中」。此前 CLI 为 Artifact 自动挂上的 live-update 订阅（以及其它内务任务）会被当成用户的后台工作，回合结束后压制「空闲」状态，卡片一直显示运行中、活动摘要写着「后台任务:live updates for artifact …」，而实际上没有任何东西在执行。现按 SDK 的 `ambient` 标记剔除这类杂务任务，只有真实后台工作（`run_in_background` 子代理、转后台的 Bash 等）才会保持运行态。
