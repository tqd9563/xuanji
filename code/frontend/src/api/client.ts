import type {
  ClosedSession,
  CronsResult,
  Dashboard,
  Memory,
  ProjectsResult,
  Replay,
  ScheduledJob,
  ScheduledRun,
  SessionsBoard,
  Skill,
  UsageReport,
  WeeklyDraft,
  WeeklyReview,
} from './types';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function mutate<T>(path: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path} → ${res.status}`);
  return json;
}

export const api = {
  dashboard: () => get<Dashboard>('/api/dashboard'),
  projects: () => get<ProjectsResult>('/api/projects'),
  sessions: () => get<SessionsBoard>('/api/sessions'),
  replay: (sessionId: string) => get<Replay>(`/api/sessions/${sessionId}/replay`),
  skills: () => get<{ skills: Skill[] }>('/api/skills'),
  memories: () => get<{ memories: Memory[] }>('/api/memories'),
  searchMemories: (q: string) =>
    get<{ memories: Memory[] }>(`/api/memories/search?q=${encodeURIComponent(q)}`),
  usage: () => get<UsageReport>('/api/usage/today'),
  palette: () => get<{ idx: Record<string, number> }>('/api/palette'),
  crons: () => get<CronsResult>('/api/crons'),
  // ---------- M2 ----------
  canResume: (sessionId: string) => get<{ ok: boolean; reason?: string }>(`/api/sessions/${sessionId}/can-resume`),
  toggleSkill: (name: string, enable: boolean) =>
    mutate<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}/toggle`, 'POST', { enable, confirm: true }),
  renameSession: (sessionId: string, name: string) =>
    mutate<{ ok: boolean }>(`/api/sessions/${sessionId}/name`, 'PUT', { name }),
  handoff: (sessionId: string) =>
    mutate<{ summary: string; from: string }>('/api/dispatch/handoff', 'POST', { sessionId }),
  closeSession: (sessionId: string) =>
    mutate<{ ok: boolean; ended: boolean }>(`/api/sessions/${sessionId}/close`, 'POST', { confirm: true }),
  closedSessions: (cwd?: string) =>
    get<{ sessions: ClosedSession[] }>(`/api/sessions/closed${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  unhideSession: (sessionId: string) =>
    mutate<{ ok: boolean }>(`/api/sessions/${sessionId}/unhide`, 'POST', {}),
  // ---------- 周回顾 ----------
  weeklyReview: (start: number, end: number) =>
    get<WeeklyReview>(`/api/weekly-review?start=${start}&end=${end}`),
  weeklyDrafts: () => get<{ drafts: WeeklyDraft[] }>('/api/weekly-review/drafts'),
  startWeeklyDraft: (start: number, end: number) =>
    mutate<{ id: number; dispatchId: string }>('/api/weekly-review/draft', 'POST', { start, end }),
  // ---------- 定时任务(M3) ----------
  schedules: () => get<{ jobs: ScheduledJob[] }>('/api/schedules'),
  createSchedule: (input: {
    kind: 'once' | 'cron';
    name: string;
    prompt: string;
    cwd: string;
    model?: string;
    permissionMode: string;
    maxBudgetUsd?: number;
    runAt?: number;
    cronExpr?: string;
  }) => mutate<{ job: ScheduledJob }>('/api/schedules', 'POST', input),
  updateSchedule: (
    id: string,
    patch: Partial<{
      name: string;
      prompt: string;
      cwd: string;
      model: string | null;
      permissionMode: string;
      maxBudgetUsd: number | null;
      runAt: number | null;
      cronExpr: string | null;
    }>,
  ) => mutate<{ job: ScheduledJob }>(`/api/schedules/${id}`, 'PATCH', patch),
  deleteSchedule: (id: string) => mutate<{ ok: boolean }>(`/api/schedules/${id}`, 'DELETE', {}),
  scheduleRuns: (id: string, limit?: number) =>
    get<{ runs: ScheduledRun[]; total: number }>(`/api/schedules/${id}/runs${limit ? `?limit=${limit}` : ''}`),
  runScheduleNow: (id: string) => mutate<{ ok: boolean }>(`/api/schedules/${id}/run-now`, 'POST', {}),
  pauseSchedule: (id: string) => mutate<{ ok: boolean }>(`/api/schedules/${id}/pause`, 'POST', {}),
  resumeSchedule: (id: string) => mutate<{ ok: boolean }>(`/api/schedules/${id}/resume`, 'POST', {}),
  cancelSchedule: (id: string) => mutate<{ ok: boolean }>(`/api/schedules/${id}/cancel`, 'POST', {}),
};

/** ws 变更订阅:scope 变化时回调,前端据此重取对应资源 */
export function subscribeChanges(onChange: (scope: string) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${wsProto}://${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'changed') onChange(msg.scope);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 3000);
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
