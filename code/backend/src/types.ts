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
