# 任务计划:璇玑(xuanji)— AI 生产管理统一入口 产品规划

> 2026-07-07 命名已定:璇玑 / xuanji(取「在璇玑玉衡,以齐七政」);开放问题 1 已关闭。

## 目标
产出一份可直接指导开发的产品规划:整体产品架构、技术选型、风险清单,覆盖 6 大功能需求(项目总览 / 任务会话总览 / 对话派发任务 / 技能一览 / 经验沉淀 / 定时任务管理)。

## 当前阶段
阶段 5(已交付,等待用户反馈)

## 各阶段

### 阶段 1:需求与发现
- [x] 理解用户意图:统一 Web 入口管理个人 AI 生产(Claude Code 为核心引擎)
- [x] 确定 6 大功能需求
- [x] 侦察本机数据源:~/.claude 目录结构、claude CLI 能力、Agent SDK 可用性
- [x] 将发现记录到 findings.md
- **状态:** complete

### 阶段 2:产品架构设计
- [x] 数据源盘点:六功能全部找到本机真实数据源(见 product-plan.md §2)
- [x] 整体架构分层(前端 SPA / 后端服务层 / Adapter 层 / Claude 底座)
- [x] 六大模块逐一设计(§4)
- **状态:** complete

### 阶段 3:技术选型
- [x] Node+TS / Hono / ws / SQLite / croner / React+shadcn;Agent SDK 为主、CLI 子进程为辅(§5)
- [x] 备选方案对比与放弃理由已记录
- **状态:** complete

### 阶段 4:风险与问题清单
- [x] 技术风险 8 条(格式漂移、会话冲突、权限、暴露面、token 失控等)
- [x] 产品风险 3 条 + 开放问题 4 条(§6)
- **状态:** complete

### 阶段 5:交付
- [x] 汇总为 product-plan.md(唯一交付文档)
- [x] 落地路线图 M0-M4(§7)
- [ ] 用户反馈后迭代(命名、访问范围、经验范围、crontab 接管 4 个开放问题)
- **状态:** in_progress

## 关键问题
1. Claude Code 的会话/项目元数据存放格式是什么?能否可靠读取"进行中"状态?
2. 对话派发任务用 Agent SDK 还是直接驱动 claude CLI(headless / PTY)?
3. 定时任务:复用系统 cron / launchd + `claude -p`,还是自建调度器?
4. 经验沉淀与现有 memory 体系(~/.claude/projects/*/memory/)如何打通?

## 已做决策
| 决策 | 理由 |
|------|------|
| 规划文件放 .planning/ai-console/ | skill scoped plan 约定,hook 可自动恢复 |

## 遇到的错误
| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| Skill "planning-with-files" 不存在 | 1 | 本机实际为 planning-with-files-zh,直接读 SKILL.md 按流程执行 |

## 备注
- 本次交付物是规划文档,不写任何代码;真正动工时按 R3 用 project-init 建骨架、按 R2 先出原型
