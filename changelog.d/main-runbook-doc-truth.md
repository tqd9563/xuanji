### 修复

- **验收面板设计文档与原型对齐真实脚本**：`wiki/tech/acceptance-runbook.md` 与 `wiki/design/prototype-runbook.html` 中 baize_web / deep_baize 的示例此前含多处凭印象写的值——后端口 8000（真值 48163）、前端 5173（真值 48164）、入口写成根路径（真值是种 Cookie 的 dev-login URL）、编造的 `local_test.sh --stop` 参数、接口路径 `/analyze_funnel_v2`（真值 `/analyze/funnel/v2`）。已全部按脚本源头更正，并补记两条易错提示（脚本自带 trap 清理时不要造 cleanup 项；`PORT` 这类 make 变量不能用 flag 追加式参数）。
