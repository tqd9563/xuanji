/** 内部领域模型 —— adapter 之上的所有层只认这些类型,不认 ~/.claude 原始格式。 */

export interface GitStatus {
  branch: string;
  /** zsh 风格:! 已修改(含暂存) */
  modified: number;
  /** ? 未跟踪 */
  untracked: number;
  /** ↑ 领先远端未推送;无 upstream 时为 null */
  ahead: number | null;
}

export interface Project {
  /** basename,用作展示名与分类色键 */
  name: string;
  /** 真实绝对路径 */
  path: string;
  /** ~/.claude/projects 下的编码目录名 */
  encodedDir: string;
  sessionCount: number;
  memoryCount: number;
  /** epoch ms;来自 history.jsonl,无记录为 null */
  lastActiveAt: number | null;
  /** 近 7 日每日 prompt 数,[6天前..今天] */
  heat: number[];
  git: GitStatus | null;
}

export type SessionState = 'running' | 'blocked' | 'idle' | 'done';

export interface AgentSession {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  /** cwd basename */
  project: string;
  kind: 'interactive' | 'background';
  state: SessionState;
  startedAt: number;
  /** 终端存活的 interactive 会话 → 只读不可接管 */
  readonly: boolean;
  /** jobs/<id>/state.json 补充 */
  detail?: string;
  needs?: string;
  tokens?: number;
  /** 来源标签:web = 璇玑派发(P2 自嵌套递归的显式标记) */
  source?: 'web';
  /** 后端进程内存活的派发会话:看板点击直接 attach 回原事件流 */
  dispatchId?: string;
  /** 最近一次产出时间:前端据此与本地已读时间比较,标「待验收」 */
  lastOutputAt?: number;
}

/** 回放事件:session jsonl 归一化产物。未知类型降级为 raw,绝不丢弃。 */
export type ReplayEvent =
  | { kind: 'user'; text: string; ts?: string }
  | { kind: 'assistant'; text: string; model?: string; ts?: string }
  | { kind: 'tool'; name: string; input: string; output?: string; isError?: boolean }
  | { kind: 'raw'; type: string; json: string };

export interface Replay {
  sessionId: string;
  events: ReplayEvent[];
  /** 解析失败跳过的行数(降级不崩溃的证据) */
  skippedLines: number;
  /** custom-title 事件里的会话名 */
  title?: string;
}

export interface Skill {
  name: string;
  description: string;
  version?: string;
  userInvocable: boolean;
  allowedTools?: string;
  source: 'user' | 'plugin';
  enabled: boolean;
  /** SKILL.md 正文(frontmatter 之后) */
  body?: string;
}

export interface Memory {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'unknown';
  /** 所属项目展示名 */
  project: string;
  projectPath: string;
  file: string;
  body: string;
  /** [[wikilink]] 引用 */
  links: string[];
}

export interface HistoryEntry {
  display: string;
  /** epoch ms */
  timestamp: number;
  /** 绝对路径 */
  project: string;
  sessionId: string;
}

// ---------- 周回顾(weekly review) ----------

export interface ReviewSession {
  sessionId: string;
  title: string;
  /** 窗口内我发出的 prompt 数(活跃口径) */
  prompts: number;
  firstAt: number;
  lastAt: number;
  /** 窗口内逐日 prompt 数,[窗口首日..末日] */
  days: number[];
  /** prompt 原文样本(截断/封顶,见 caliber) */
  promptTexts: string[];
  /** terminal = history.jsonl;web = 璇玑派发流水 */
  source: 'terminal' | 'web';
  /** 窗口内该会话的 token 成本(USD,按记录时间过滤) */
  costUsd: number;
}

export interface ReviewProject {
  /** basename 展示名(分类色键) */
  project: string;
  /** 真实绝对路径 */
  path: string;
  prompts: number;
  days: number[];
  costUsd: number;
  /** 窗口内 git commit 题目(--all --no-merges,封顶截取);非 git 目录为空 */
  commits: string[];
  sessions: ReviewSession[];
}

export interface WeeklyReview {
  range: { start: number; end: number; dayCount: number };
  totals: {
    prompts: number;
    sessions: number;
    projects: number;
    /** 有 ≥1 条 prompt 的自然日数 */
    activeDays: number;
    costUsd: number;
  };
  projects: ReviewProject[];
  caliber: Record<string, string>;
  computedAt: number;
}

/** 周报草稿(自有数据,SQLite) */
export interface WeeklyDraft {
  id: number;
  rangeStart: number;
  rangeEnd: number;
  status: 'running' | 'done' | 'error';
  content: string | null;
  error: string | null;
  model: string;
  /** 生成草稿的派发会话(可在看板跟踪/续接迭代) */
  sessionId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SessionUsage {
  sessionId: string;
  title: string;
  byModel: ModelUsage[];
  totalCostUsd: number;
}

export interface ProjectUsage {
  project: string;
  byModel: ModelUsage[];
  totalCostUsd: number;
  sessions: SessionUsage[];
}

// ---------- 定时任务(scheduled jobs,自有数据 SQLite) ----------

export type ScheduledJobKind = 'once' | 'cron';

/**
 * pending  待执行(排程未到点 / cron 等待下次)
 * running  已触发,派发会话进行中
 * blocked  会话卡在权限审批,挂起等用户处理(不计入熔断失败)
 * done     一次性:成功完成,终态;周期:本期成功,已回到 pending 等下一期
 * error    一次性:本次运行失败,终态
 * fused    周期:连续失败达阈值,调度已停止
 * missed   一次性:错过触发且超出补跑宽限期
 * canceled 用户取消(一次性)
 * paused   用户暂停(周期)
 */
export type ScheduledJobStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'done'
  | 'error'
  | 'fused'
  | 'missed'
  | 'canceled'
  | 'paused';

export interface ScheduledJob {
  id: string;
  kind: ScheduledJobKind;
  name: string;
  prompt: string;
  cwd: string;
  model: string | null;
  permissionMode: string;
  /** 单次运行预算上限(USD),null = 不限。软上限:回合结束后核对,超出记录但不能中途打断(SDK 未暴露增量成本流) */
  maxBudgetUsd: number | null;
  /** kind='once' 的计划执行时间(epoch ms) */
  runAt: number | null;
  /** kind='cron' 的 cron 表达式(croner 语法,Asia/Shanghai 时区) */
  cronExpr: string | null;
  status: ScheduledJobStatus;
  /** 连续失败计数:达 3 熔断(仅 cron 有意义) */
  consecutiveFailures: number;
  /** 最近一次触发产生的派发会话 id;前端「结果会话」跳转与只读回放的入口 */
  resultSessionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** 下次触发时间(epoch ms),由 croner 计算回填,pending 态才有意义 */
  nextRunAt: number | null;
}

export interface ScheduledRun {
  id: number;
  jobId: string;
  /** 计划触发时间(epoch ms);错过/延迟触发时与 startedAt 存在差值 */
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: 'running' | 'done' | 'error' | 'blocked' | 'missed';
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
}
