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
  type: 'user' | 'feedback' | 'project' | 'reference' | 'unknown';
  project: string;
  projectPath: string;
  file: string;
  body: string;
  links: string[];
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

export interface ProjectsResult {
  projects: Project[];
  filteredNoise: number;
  filteredMissing: number;
}

export interface Dashboard {
  needsAttention: AgentSession[];
  running: AgentSession[];
  strip: {
    todayPrompts: number;
    todayTokensInOut: number;
    todayCacheRead: number;
    todayCostUsd: number;
    activeProjects: number;
    systemCrons: number;
  };
  timeline: { time: number; project: string; message: string }[];
  heat: { project: string; days: number[] }[];
  usage: UsageReport;
  caliber: Record<string, string>;
  health: { cli: string | null; agentsOk: boolean };
}

export interface CronsResult {
  app: unknown[];
  system: string[];
  caliber: string;
}
