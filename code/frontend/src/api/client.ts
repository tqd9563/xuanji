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
  Todo,
  UsageReport,
  WeeklyDraft,
  WeeklyReview,
  WorklogCard,
} from './types';
import { ensureConfirmToken, forgetConfirmToken, notifyUnauthorized, type AuthStatus } from '@/lib/auth';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (res.status === 401) {
    notifyUnauthorized();
    throw new Error('未登录或会话已过期');
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * 写请求。开了二次确认的部署里先带上内存中的口令;服务端判 403 needConfirm 时
 * 重新问一次口令再重试——首次操作与口令输错都走这条路,调用方无需感知。
 */
async function mutate<T>(path: string, method: string, body: unknown): Promise<T> {
  const send = async (token: string | null) => {
    const payload = token ? { ...(body as object), confirmToken: token } : body;
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; needConfirm?: boolean };
    return { res, json };
  };

  let { res, json } = await send(await ensureConfirmToken());
  if (res.status === 403 && json.needConfirm) {
    const retry = await ensureConfirmToken(true);
    if (!retry) throw new Error('已取消:该操作需要二次确认口令');
    ({ res, json } = await send(retry));
  }
  if (res.status === 401) {
    notifyUnauthorized();
    throw new Error('未登录或会话已过期');
  }
  if (!res.ok) throw new Error(json.error ?? `${path} → ${res.status}`);
  return json;
}

/** 登录/注销/状态。登录接口不走 mutate:它本身就是拿凭证的入口,不该被二次口令逻辑套住。 */
export const auth = {
  status: () => get<AuthStatus>('/api/auth/status'),
  login: async (password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(json.error ?? '登录失败');
  },
  logout: async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    forgetConfirmToken();
  },
};

export const api = {
  dashboard: () => get<Dashboard>('/api/dashboard'),
  projects: () => get<ProjectsResult>('/api/projects'),
  sessions: () => get<SessionsBoard>('/api/sessions'),
  replay: (sessionId: string) => get<Replay>(`/api/sessions/${sessionId}/replay`),
  skills: () => get<{ skills: Skill[] }>('/api/skills'),
  memories: () => get<{ memories: Memory[] }>('/api/memories'),
  searchMemories: (q: string) =>
    get<{ memories: Memory[] }>(`/api/memories/search?q=${encodeURIComponent(q)}`),
  /** 任务总结:窗口/项目/状态/关键词过滤全在后端做,前端只管展示 */
  worklog: (f?: { start?: number; end?: number; project?: string; status?: string; q?: string }) => {
    const p = new URLSearchParams();
    if (f?.start) p.set('start', String(f.start));
    if (f?.end) p.set('end', String(f.end));
    if (f?.project) p.set('project', f.project);
    if (f?.status && f.status !== 'all') p.set('status', f.status);
    if (f?.q) p.set('q', f.q);
    const qs = p.toString();
    return get<{ cards: WorklogCard[] }>(`/api/worklog${qs ? `?${qs}` : ''}`);
  },
  usage: () => get<UsageReport>('/api/usage/today'),
  // ---------- 待办 ----------
  todos: () => get<{ todos: Todo[] }>('/api/todos'),
  /** cwd 传绝对路径(界面已选好)或短名(外部脚本手打),后端统一宽松匹配 */
  createTodo: (title: string, cwd?: string | null) =>
    mutate<{ todo: Todo }>('/api/todos', 'POST', { title, cwd: cwd ?? null }),
  updateTodo: (id: number, patch: Partial<{ title: string; status: Todo['status']; cwd: string | null; sessionId: string | null }>) =>
    mutate<{ todo: Todo }>(`/api/todos/${id}`, 'PATCH', patch),
  deleteTodo: (id: number) => mutate<{ ok: boolean }>(`/api/todos/${id}`, 'DELETE', {}),
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
  openUrl: (url: string) => mutate<{ ok: boolean }>('/api/open-url', 'POST', { url }),
  closeSession: (sessionId: string) =>
    mutate<{ ok: boolean; ended: boolean }>(`/api/sessions/${sessionId}/close`, 'POST', { confirm: true }),
  closedSessions: (cwd?: string) =>
    get<{ sessions: ClosedSession[] }>(`/api/sessions/closed${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  unhideSession: (sessionId: string) =>
    mutate<{ ok: boolean }>(`/api/sessions/${sessionId}/unhide`, 'POST', {}),
  archiveSession: (sessionId: string) =>
    mutate<{ ok: boolean }>(`/api/sessions/${sessionId}/archive`, 'PUT', {}),
  unarchiveSession: (sessionId: string) =>
    mutate<{ ok: boolean }>(`/api/sessions/${sessionId}/archive`, 'DELETE', {}),
  suspendSession: (sessionId: string) =>
    mutate<{ ok: boolean }>(`/api/sessions/${sessionId}/suspend`, 'PUT', {}),
  unsuspendSession: (sessionId: string) =>
    mutate<{ ok: boolean }>(`/api/sessions/${sessionId}/suspend`, 'DELETE', {}),
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
    // 401 会让 upgrade 直接被拒,表现为 onclose;这里回探一次登录态,避免界面卡在「静默不刷新」
    ws.onclose = () => {
      if (closed) return;
      void auth.status()
        .then((s) => {
          if (s.authEnabled && !s.loggedIn) notifyUnauthorized();
        })
        .catch(() => {/* 后端不可达,交给下面的重连退避 */})
        .finally(() => {
          if (!closed) setTimeout(connect, 3000);
        });
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
