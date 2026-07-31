/** 与 code/backend/src/types.ts 保持镜像的前端契约类型 */

export interface GitStatus {
  branch: string;
  modified: number;
  untracked: number;
  ahead: number | null;
}

export interface Project {
  name: string;
  path: string;
  encodedDir: string;
  sessionCount: number;
  memoryCount: number;
  lastActiveAt: number | null;
  heat: number[];
  git: GitStatus | null;
}

export type SessionState = 'running' | 'blocked' | 'idle' | 'done';

export interface AgentSession {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  project: string;
  kind: 'interactive' | 'background';
  state: SessionState;
  startedAt: number;
  readonly: boolean;
  detail?: string;
  needs?: string;
  tokens?: number;
  source?: 'web';
  /** 后端进程内存活的派发会话:点击直接 attach 回原事件流 */
  dispatchId?: string;
  /** 最近一次产出时间:与本地已读表比较,标「待验收」 */
  lastOutputAt?: number;
  /** 手动拖到「已完成」的归档卡:提供撤销入口 */
  archived?: boolean;
}

export type ReplayEvent =
  | { kind: 'user'; text: string; ts?: string }
  | { kind: 'assistant'; text: string; model?: string; ts?: string }
  | { kind: 'tool'; name: string; input: string; output?: string; isError?: boolean }
  | { kind: 'raw'; type: string; json: string };

export interface Replay {
  sessionId: string;
  events: ReplayEvent[];
  skippedLines: number;
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
  body?: string;
}

export interface Memory {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'cross-project' | 'unknown';
  project: string;
  projectPath: string;
  file: string;
  body: string;
  links: string[];
}

/** 任务总结(wrapup skill 落在 ~/.claude/worklog/ 的一张卡) */
export interface WorklogCard {
  name: string;
  date: string;
  project: string;
  task: string;
  branch?: string;
  commits: string[];
  mr?: string;
  refs: string[];
  status: 'merged' | 'pending-merge' | 'unresolved' | 'unknown';
  session?: string;
  coversUntil?: string;
  file: string;
  sections: WorklogSections;
  degraded: boolean;
}

export interface WorklogSections {
  problem?: string;
  conclusion?: string;
  excluded: string[];
  residue: string[];
  decisions: string[];
  files: string[];
  raw?: string;
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

export interface UsageReport {
  projects: ProjectUsage[];
  totalCostUsd: number;
  totalTokens: { inOut: number; cacheRead: number };
  caliber: string;
  computedAt: number;
}

export interface SessionsBoard {
  ok: boolean;
  error?: string;
  columns: Record<SessionState, AgentSession[]>;
  refreshedAt: number;
}

/** 已关闭(隐藏)会话:/resume 弹窗列表项 */
export interface ClosedSession {
  sessionId: string;
  name: string;
  cwd: string;
  project: string;
  hiddenAt: number;
}

export interface ProjectsResult {
  projects: Project[];
  filteredNoise: number;
  filteredMissing: number;
}

export interface Dashboard {
  needsAttention: AgentSession[];
  running: AgentSession[];
  /** 「待验收」候选(空闲/已完成且有产出时间):是否未读由前端本地已读表判定 */
  reviewCandidates?: AgentSession[];
  strip: {
    todayPrompts: number;
    todayTokensInOut: number;
    todayCacheRead: number;
    todayCostUsd: number;
    activeProjects: number;
    systemCrons: number;
    scheduledJobs: { normal: number; fused: number; missed: number };
  };
  timeline: { time: number; project: string; message: string }[];
  heat: { project: string; days: number[] }[];
  usage: UsageReport;
  caliber: Record<string, string>;
  health: { cli: string | null; agentsOk: boolean };
}

// ---------- 定时任务(M3) ----------

export type ScheduledJobKind = 'once' | 'cron';

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
  maxBudgetUsd: number | null;
  runAt: number | null;
  cronExpr: string | null;
  status: ScheduledJobStatus;
  consecutiveFailures: number;
  resultSessionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
}

export interface ScheduledRun {
  id: number;
  jobId: string;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: 'running' | 'done' | 'error' | 'blocked' | 'missed';
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface CronsResult {
  app: ScheduledJob[];
  system: string[];
  caliber: string;
}

// ---------- 周回顾 ----------

export interface ReviewSession {
  sessionId: string;
  title: string;
  prompts: number;
  firstAt: number;
  lastAt: number;
  days: number[];
  promptTexts: string[];
  source: 'terminal' | 'web';
  costUsd: number;
}

export interface ReviewProject {
  project: string;
  path: string;
  prompts: number;
  days: number[];
  costUsd: number;
  commits: string[];
  sessions: ReviewSession[];
}

export interface WeeklyReview {
  range: { start: number; end: number; dayCount: number };
  totals: { prompts: number; sessions: number; projects: number; activeDays: number; costUsd: number };
  projects: ReviewProject[];
  caliber: Record<string, string>;
  computedAt: number;
}

export interface WeeklyDraft {
  id: number;
  rangeStart: number;
  rangeEnd: number;
  status: 'running' | 'done' | 'error';
  content: string | null;
  error: string | null;
  model: string;
  sessionId: string | null;
  createdAt: number;
  finishedAt: number | null;
}
