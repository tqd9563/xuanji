/**
 * AgentsCliAdapter —— 包装 `claude agents --json` 官方 CLI 出口。
 * 失败降级为空列表 + 健康标记,不 crash(T6 风险缓解)。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentSession, SessionState } from '../types.js';

const execFileP = promisify(execFile);

export interface RawAgent {
  id: string;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name?: string;
  pid?: number;
  state?: string;
  status?: string;
}

/** agents JSON 的 state/status → 内部四态。未知值按运行痕迹保守归为 idle。 */
export function normalizeState(raw: RawAgent): SessionState {
  const s = (raw.state ?? raw.status ?? '').toLowerCase();
  if (s === 'blocked' || s === 'waiting') return 'blocked';
  if (s === 'done' || s === 'exited' || s === 'completed') return 'done';
  if (s === 'running' || s === 'working' || s === 'busy') return 'running';
  if (s === 'idle') return 'idle';
  // 未知状态:有存活 pid 视为 running,否则 idle
  return raw.pid ? 'running' : 'idle';
}

export function toAgentSession(raw: RawAgent): AgentSession {
  const state = normalizeState(raw);
  const kind = raw.kind === 'interactive' ? 'interactive' : 'background';
  const pidAlive = raw.pid ? isPidAlive(raw.pid) : false;
  return {
    id: raw.id,
    sessionId: raw.sessionId,
    name: raw.name?.trim() || raw.id,
    cwd: raw.cwd,
    project: raw.cwd.split('/').filter(Boolean).pop() ?? raw.cwd,
    kind,
    state,
    startedAt: raw.startedAt,
    readonly: kind === 'interactive' && pidAlive,
  };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface AgentsResult {
  ok: boolean;
  sessions: AgentSession[];
  error?: string;
}

export async function listAgents(): Promise<AgentsResult> {
  try {
    const { stdout } = await execFileP('claude', ['agents', '--json', '--all'], {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const arr = JSON.parse(stdout);
    if (!Array.isArray(arr)) return { ok: false, sessions: [], error: 'unexpected output shape' };
    const sessions = arr
      .filter((a: any) => a && typeof a.id === 'string' && typeof a.sessionId === 'string')
      .map((a: RawAgent) => toAgentSession(a));
    return { ok: true, sessions };
  } catch (e) {
    return { ok: false, sessions: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function cliVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('claude', ['--version'], { timeout: 10_000 });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/** 转后台派发:claude --bg,daemon 托管,立即返回(在 cwd 下执行) */
export async function bgDispatch(cwd: string, prompt: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileP('claude', ['--bg', prompt], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output: (stdout + stderr).trim().slice(0, 500) };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/** 交接摘要:headless 一发,低成本模型,无工具 */
export async function summarizeForHandoff(transcript: string): Promise<string> {
  const prompt = `以下是一段 AI 会话的记录节选。请生成一份简洁的交接摘要(中文,≤300字),分三部分:结论、未完成事项、关键口径/约束。只输出摘要本身。\n\n---\n${transcript.slice(0, 24000)}`;
  const { stdout } = await execFileP(
    'claude',
    ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'text'],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}

/** 系统 crontab 只读列出(M1:展示不接管) */
export async function readCrontab(): Promise<string[]> {
  try {
    const { stdout } = await execFileP('crontab', ['-l'], { timeout: 5_000 });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}
