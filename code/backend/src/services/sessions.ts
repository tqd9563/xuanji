import { config } from '../config.js';
import { listAgents } from '../adapters/agents-cli.js';
import { findSessionFile, parseReplay, readJobStates } from '../adapters/claude-dir.js';
import type { AgentSession, Replay, SessionState } from '../types.js';

export interface SessionsBoard {
  ok: boolean;
  error?: string;
  columns: Record<SessionState, AgentSession[]>;
  refreshedAt: number;
}

export async function sessionsBoard(): Promise<SessionsBoard> {
  const [agents, jobStates] = await Promise.all([listAgents(), readJobStates(config.claudeDir)]);
  const columns: Record<SessionState, AgentSession[]> = {
    idle: [],
    running: [],
    blocked: [],
    done: [],
  };
  for (const s of agents.sessions) {
    const job = jobStates.get(s.id);
    if (job) {
      s.detail = job.detail;
      s.needs = job.needs;
      s.tokens = job.tokens;
    }
    columns[s.state].push(s);
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
