# Changelog

本文件记录璇玑(xuanji)项目的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- **产品规划**:迁入完整产品规划文档(`.planning/xuanji/`),含产品定位、六大模块数据源盘点与设计、整体架构、技术选型、风险清单及 M0-M4 落地路线图;命名定为「璇玑」,取《尚书·舜典》「在璇玑玉衡,以齐七政」。
- **项目级 CLAUDE.md**:固化技术栈(Node/TS + Hono,明确禁止 Python 后端)、project-init 适配约定、三条架构铁律与流程规则,保证任何新开会话都继承正确上下文。

### 变更
- **脚手架约定**:明确 project-init skill 的适配方式——结构不变量(code/ + wiki 四目录 + README + 原型关卡)全保留,Python 专属细节替换为 Node 等价物(uv→pnpm、FastAPI→Hono、pytest→vitest);项目 agent 规则文件按全局 R3 用 CLAUDE.md 而非 AGENTS.md。
