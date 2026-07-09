import { config } from '../config.js';
import { listAgents } from '../adapters/agents-cli.js';
import { findSessionFile, parseReplay, readJobStates } from '../adapters/claude-dir.js';
import { dispatchBoardState, liveDispatches } from './dispatch.js';
import type { AgentSession, Replay, SessionState } from '../types.js';
import type { Storage } from '../storage/db.js';

export interface SessionsBoard {
  ok: boolean;
  error?: string;
  columns: Record<SessionState, AgentSession[]>;
  refreshedAt: number;
}

export async function sessionsBoard(storage?: Storage): Promise<SessionsBoard> {
  const [agents, jobStates] = await Promise.all([listAgents(), readJobStates(config.claudeDir)]);
  const names = storage?.sessionNames();
  const webIds = storage?.webDispatchedIds();
  const hidden = storage?.hiddenSessionIds();
  const columns: Record<SessionState, AgentSession[]> = {
    idle: [],
    running: [],
    blocked: [],
    done: [],
  };
  // 本进程存活的派发会话:agents CLI 把它们列为 interactive+活 pid(名字还是自动生成的),
  // 用注册表的实时状态/会话名/attach 入口覆盖,CLI 尚未收录的补充合成卡
  const live = new Map(liveDispatches().map((d) => [d.sessionId, d]));
  for (const s of agents.sessions) {
    if (hidden?.has(s.sessionId)) continue; // 用户已「关闭」:仅从看板隐藏,~/.claude 数据不动
    const job = jobStates.get(s.id);
    if (job) {
      s.detail = job.detail;
      s.needs = job.needs;
      s.tokens = job.tokens;
      s.lastOutputAt = job.updatedAt;
    }
    const d = live.get(s.sessionId);
    if (d) {
      live.delete(s.sessionId);
      s.name = d.name;
      s.state = dispatchBoardState(d.state);
      s.readonly = false;
      s.source = 'web';
      s.dispatchId = d.dispatchId;
      s.lastOutputAt = d.lastOutputAt;
      if (d.state === 'awaiting-permission') {
        s.needs = d.detail === '回答 Claude 的提问' ? d.detail : `等待权限审批:${d.detail ?? ''}`;
      } else {
        s.needs = undefined;
        if (d.detail) s.detail = d.detail; // 运行中=正在做什么 / 空闲=最后产出摘要
      }
    }
    const override = names?.get(s.sessionId);
    if (override) s.name = override;
    if (webIds?.has(s.sessionId)) s.source = 'web';
    columns[s.state].push(s);
  }
  const seen = new Set(agents.sessions.map((s) => s.sessionId));
  for (const d of live.values()) {
    if (hidden?.has(d.sessionId)) continue;
    seen.add(d.sessionId);
    columns[dispatchBoardState(d.state)].push({
      id: d.sessionId.slice(0, 8),
      sessionId: d.sessionId,
      name: names?.get(d.sessionId) ?? d.name,
      cwd: d.cwd,
      project: d.cwd.split('/').filter(Boolean).pop() ?? d.cwd,
      kind: 'background',
      state: dispatchBoardState(d.state),
      startedAt: d.startedAt,
      readonly: false,
      detail: d.state === 'awaiting-permission' ? undefined : d.detail,
      needs:
        d.state === 'awaiting-permission'
          ? d.detail === '回答 Claude 的提问'
            ? d.detail
            : `等待权限审批:${d.detail ?? ''}`
          : undefined,
      source: 'web',
      dispatchId: d.dispatchId,
      lastOutputAt: d.lastOutputAt,
    });
  }
  // 历史 web 派发会话:进程已退出且 agents CLI 不再列出的,从自有 dispatches 表补回(bg fork 出的会话不再消失)
  for (const row of storage?.allDispatches() ?? []) {
    if (seen.has(row.sessionId) || hidden?.has(row.sessionId)) continue;
    columns.done.push({
      id: row.sessionId.slice(0, 8),
      sessionId: row.sessionId,
      name: names?.get(row.sessionId) ?? row.name ?? row.sessionId.slice(0, 8),
      cwd: row.cwd,
      project: row.cwd.split('/').filter(Boolean).pop() ?? row.cwd,
      kind: 'background',
      state: 'done',
      startedAt: row.createdAt,
      readonly: false,
      source: 'web',
    });
  }
  for (const col of Object.values(columns)) col.sort((a, b) => b.startedAt - a.startedAt);
  return { ok: agents.ok, error: agents.error, columns, refreshedAt: Date.now() };
}

export async function sessionReplay(sessionId: string): Promise<Replay | null> {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null; // 路径注入防护
  const file = await findSessionFile(config.claudeDir, sessionId);
  if (!file) return null;
  return parseReplay(file, sessionId);
}
