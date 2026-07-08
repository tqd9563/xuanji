import type {
  CronsResult,
  Dashboard,
  Memory,
  ProjectsResult,
  Replay,
  SessionsBoard,
  Skill,
  UsageReport,
} from './types';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
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
  crons: () => get<CronsResult>('/api/crons'),
};

/** ws 变更订阅:scope 变化时回调,前端据此重取对应资源 */
export function subscribeChanges(onChange: (scope: string) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`ws://${location.host}/ws`);
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
