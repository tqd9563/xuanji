### 修复
- **技能页插件技能数量虚高**：此前把 `~/.claude/plugins/marketplaces/` 里插件市场的整仓克隆也当成已安装插件,技能页列出 166 个插件技能;现在只列 `installed_plugins.json` 里用户级安装的插件,本机实测降为 31 个,「已启用」计数随之准确。
- **插件启用状态取真实开关**：插件技能的启用态改读 `settings.json` 的 `enabledPlugins`(即 `claude plugin enable/disable` 的开关),此前一律显示为已启用。
- **插件技能与同名用户技能互相吞并**：插件技能改用 `插件名:技能名` 全名显示(与实际调用名一致),同名的用户技能(如 `sites` 与 `lisites:sites`)不再被去重吞掉,触发次数也按全名精确统计,不再串到同名技能上。
