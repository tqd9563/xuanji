/**
 * 派发服务:Agent SDK query() 流式会话的持有者。
 * - streaming-input 模式:多轮输入经 AsyncQueue 推入
 * - canUseTool → 前端审批卡(允许一次 / 本次会话总是允许 / 拒绝)
 * - resume 前执行所有权检查(终端存活的 interactive 会话拒绝接管)
 * - blocked / 回合结束 → macOS 横幅(仅璇玑派发的会话)
 */
import { randomUUID } from 'node:crypto';
import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { listAgents } from '../adapters/agents-cli.js';
import type { AgentSession } from '../types.js';
import { notifyMac } from '../adapters/notify.js';
import type { Storage } from '../storage/db.js';

// ---------- 输入队列(streaming input) ----------

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const r of this.resolvers.splice(0)) r({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.resolvers.push(res));
      },
    };
  }
}

// ---------- 对外事件(→ 前端 ws) ----------

export type DispatchEvent =
  | { ev: 'init'; sessionId: string; model: string }
  | { ev: 'status'; state: 'working' | 'awaiting-permission' | 'idle' | 'ended'; detail?: string }
  | { ev: 'delta'; text: string }
  | { ev: 'assistant'; text: string }
  | { ev: 'tool'; id: string; name: string; input: string }
  | { ev: 'tool-result'; id: string; output: string; isError: boolean }
  | {
      ev: 'permission-request';
      requestId: string;
      toolName: string;
      title: string;
      input: string;
      hasSuggestions: boolean;
    }
  | { ev: 'permission-resolved'; requestId: string; decision: string }
  | { ev: 'result'; costUsd: number; contextTokens: number; contextPct: number; durationMs: number }
  | { ev: 'rate-limit'; kind: string; utilization: number; resetsAt?: number }
  | { ev: 'user-echo'; text: string }
  | { ev: 'forked'; from: string; to: string }
  | { ev: 'error'; message: string };

const CONTEXT_WINDOW = 200_000;

interface Pending {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  /** 原始工具入参:allow 必须原样回传 updatedInput(SDK Zod 校验要求) */
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
}

export class DispatchSession {
  readonly id = randomUUID();
  sessionId: string | null = null;
  readonly events: DispatchEvent[] = [];
  private listeners = new Set<(e: DispatchEvent) => void>();
  private input = new AsyncQueue<SDKUserMessage>();
  private q: Query | null = null;
  private pending = new Map<string, Pending>();
  private storage: Storage;
  readonly cwd: string;
  private name: string;
  private resumeFrom: string | null;
  private fork: boolean;
  readonly startedAt = Date.now();
  /** 最近一次 status 事件,供会话看板注入实时状态 */
  state: 'working' | 'awaiting-permission' | 'idle' | 'ended' = 'working';
  stateDetail: string | undefined;
  /** SDK 子进程 stderr 尾部环形缓冲:进程异常退出时是唯一的真实报错来源 */
  private stderrTail: string[] = [];

  constructor(
    storage: Storage,
    opts: { cwd: string; permissionMode?: string; model?: string; resume?: string; fork?: boolean; name?: string },
  ) {
    this.storage = storage;
    this.cwd = opts.cwd;
    this.name = opts.name ?? '新会话';
    this.resumeFrom = opts.resume ?? null;
    this.fork = opts.fork ?? false;
    this.q = query({
      prompt: this.input,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        permissionMode: (opts.permissionMode as never) ?? 'default',
        resume: opts.resume,
        // bg 后台代理会话归 daemon 所有,CLI 拒绝直接 --resume,只能分叉副本续接
        forkSession: opts.fork || undefined,
        includePartialMessages: true,
        // 与终端一致的 user 级 skills / MCP / CLAUDE.md(含项目级)
        settingSources: ['user', 'project', 'local'],
        stderr: (data: string) => {
          for (const line of data.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            this.stderrTail.push(t);
            if (this.stderrTail.length > 40) this.stderrTail.shift();
          }
        },
        canUseTool: (toolName, input, { suggestions, title }) => this.onPermission(toolName, input, suggestions, title),
      },
    });
    void this.consume();
  }

  // ---------- 事件流 ----------

  get displayName(): string {
    return this.name;
  }

  private emit(e: DispatchEvent) {
    if (e.ev === 'status') {
      this.state = e.state;
      this.stateDetail = e.detail;
    }
    this.events.push(e);
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
    for (const l of this.listeners) l(e);
  }

  subscribe(l: (e: DispatchEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private async consume() {
    try {
      for await (const msg of this.q!) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              this.sessionId = msg.session_id;
              this.storage.recordDispatch(msg.session_id, this.cwd);
              this.emit({ ev: 'init', sessionId: msg.session_id, model: (msg as { model?: string }).model ?? '' });
              if (this.fork && this.resumeFrom && msg.session_id !== this.resumeFrom) {
                this.emit({ ev: 'forked', from: this.resumeFrom, to: msg.session_id });
              }
              this.emit({ ev: 'status', state: 'working' });
            }
            break;
          case 'stream_event': {
            const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              this.emit({ ev: 'delta', text: ev.delta.text });
            }
            break;
          }
          case 'assistant': {
            const blocks = (msg.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
            for (const b of blocks) {
              if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                this.emit({ ev: 'assistant', text: b.text });
              } else if (b.type === 'tool_use') {
                this.emit({
                  ev: 'tool',
                  id: String(b.id),
                  name: String(b.name),
                  input: compact(b.input),
                });
              }
            }
            break;
          }
          case 'user': {
            const content = (msg.message as { content?: unknown }).content;
            if (Array.isArray(content)) {
              for (const b of content as Array<Record<string, unknown>>) {
                if (b.type === 'tool_result') {
                  this.emit({
                    ev: 'tool-result',
                    id: String(b.tool_use_id),
                    output: stringifyResult(b.content),
                    isError: b.is_error === true,
                  });
                }
              }
            }
            break;
          }
          case 'result': {
            const usage = (msg as unknown as { usage?: Record<string, number> }).usage ?? {};
            const contextTokens =
              (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            this.emit({
              ev: 'result',
              costUsd: (msg as { total_cost_usd?: number }).total_cost_usd ?? 0,
              contextTokens,
              contextPct: Math.min(100, Math.round((contextTokens / CONTEXT_WINDOW) * 100)),
              durationMs: (msg as { duration_ms?: number }).duration_ms ?? 0,
            });
            this.emit({ ev: 'status', state: 'idle' });
            notifyMac(this.name, '回合完成,等待你的下一步指示');
            break;
          }
          case 'rate_limit_event': {
            const info = (msg as { rate_limit_info?: { rateLimitType?: string; utilization?: number; resetsAt?: number } })
              .rate_limit_info;
            if (info?.rateLimitType && typeof info.utilization === 'number') {
              this.emit({
                ev: 'rate-limit',
                kind: info.rateLimitType,
                utilization: info.utilization,
                resetsAt: info.resetsAt,
              });
            }
            break;
          }
          default:
            break; // 其余 SDK 消息类型 M2 不消费
        }
      }
      this.emit({ ev: 'status', state: 'ended' });
    } catch (e) {
      let message = e instanceof Error ? e.message : String(e);
      // 子进程异常退出时 SDK 只给 exit code,把 stderr 尾部一并透出才可诊断
      const tail = this.stderrTail.slice(-6);
      if (tail.length && /exited with code/.test(message)) {
        message += `\n${tail.join('\n')}`;
      }
      this.emit({ ev: 'error', message });
      this.emit({ ev: 'status', state: 'ended' });
    }
  }

  // ---------- 审批 ----------

  private onPermission(
    toolName: string,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[] | undefined,
    title: string | undefined,
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    this.emit({ ev: 'status', state: 'awaiting-permission', detail: toolName });
    this.emit({
      ev: 'permission-request',
      requestId,
      toolName,
      title: title ?? `${toolName}(${compact(input)})`,
      input: compact(input),
      hasSuggestions: !!suggestions?.length,
    });
    notifyMac(this.name, `等待审批:${toolName}`);
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, toolName, input, suggestions });
    });
  }

  resolvePermission(requestId: string, decision: 'allow' | 'always' | 'deny') {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    this.emit({ ev: 'permission-resolved', requestId, decision });
    this.emit({ ev: 'status', state: 'working' });
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: '用户在璇玑界面拒绝了此操作', interrupt: false });
    } else if (decision === 'always' && p.suggestions?.length) {
      p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions });
    } else {
      p.resolve({ behavior: 'allow', updatedInput: p.input });
    }
  }

  // ---------- 输入 / 控制 ----------

  send(text: string) {
    this.emit({ ev: 'user-echo', text });
    this.emit({ ev: 'status', state: 'working' });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  async interrupt() {
    await this.q?.interrupt().catch(() => {});
  }

  async end() {
    this.input.close();
    await this.q?.interrupt().catch(() => {});
  }
}

// ---------- 管理器 ----------

const sessions = new Map<string, DispatchSession>();

export function createDispatch(
  storage: Storage,
  opts: { cwd: string; permissionMode?: string; model?: string; resume?: string; fork?: boolean; name?: string },
): DispatchSession {
  const s = new DispatchSession(storage, opts);
  sessions.set(s.id, s);
  return s;
}

export function getDispatch(id: string): DispatchSession | undefined {
  return sessions.get(id);
}

/** 结束并移除进程内存活的派发会话(看板「关闭」);返回是否命中 */
export async function endDispatchBySessionId(sessionId: string): Promise<boolean> {
  for (const [id, s] of sessions) {
    if (s.sessionId === sessionId) {
      await s.end();
      sessions.delete(id);
      return true;
    }
  }
  return false;
}

export interface LiveDispatch {
  dispatchId: string;
  sessionId: string;
  cwd: string;
  name: string;
  state: DispatchSession['state'];
  detail?: string;
  startedAt: number;
}

/** 后端进程内存活的派发会话(已拿到 sessionId 的),供看板注入实时状态与 attach 入口 */
export function liveDispatches(): LiveDispatch[] {
  const out: LiveDispatch[] = [];
  for (const s of sessions.values()) {
    if (!s.sessionId) continue;
    out.push({
      dispatchId: s.id,
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: s.displayName,
      state: s.state,
      detail: s.stateDetail,
      startedAt: s.startedAt,
    });
  }
  return out;
}

/** 派发会话状态 → 看板四态 */
export function dispatchBoardState(state: DispatchSession['state']): 'running' | 'blocked' | 'idle' | 'done' {
  if (state === 'working') return 'running';
  if (state === 'awaiting-permission') return 'blocked';
  if (state === 'ended') return 'done';
  return 'idle';
}

/**
 * 所有权规则:
 * - 终端存活的 interactive 会话只读,拒绝接管
 * - bg 后台代理会话归 daemon 所有,CLI 拒绝直接 --resume → 以 fork 副本续接(原会话不受影响)
 * - 其余(web 派发/已退出终端)直接 resume
 */
export function resumePolicy(
  agents: AgentSession[],
  sessionId: string,
): { ok: true; fork: boolean } | { ok: false; reason: string } {
  const live = agents.find((s) => s.sessionId === sessionId);
  if (live?.readonly) {
    return { ok: false, reason: '终端存活的交互会话只读,不可接管(会话所有权规则)' };
  }
  return { ok: true, fork: live?.kind === 'background' };
}

export async function canResume(sessionId: string): Promise<{ ok: boolean; reason?: string; fork?: boolean }> {
  // 本进程存活的派发会话是我们自己的:agents CLI 会把它列为 interactive+活 pid,须在只读判定前放行
  for (const s of sessions.values()) {
    if (s.sessionId === sessionId) return { ok: true, fork: false };
  }
  const agents = await listAgents();
  return resumePolicy(agents.sessions, sessionId);
}

// ---------- 工具 ----------

function compact(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 500);
  const j = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'pattern', 'query', 'prompt', 'url', 'skill', 'description']) {
    if (typeof j[key] === 'string') return (j[key] as string).slice(0, 500);
  }
  try {
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return String(input).slice(0, 500);
  }
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 4000);
  if (Array.isArray(content)) {
    return content
      .map((b) => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('\n')
      .slice(0, 4000);
  }
  try {
    return JSON.stringify(content).slice(0, 4000);
  } catch {
    return '';
  }
}
