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
  type EffortLevel,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { listAgents } from '../adapters/agents-cli.js';
import type { AgentSession, InlineImage } from '../types.js';
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
  /**
   * 思考流:仅在 thinking.display='summarized' 下才有明文(模型自写的英文摘要,非逐字原文)。
   * 明文为空时后端不发本事件,所以前端「收到 thinking-delta」即等价于「确有可展示的思考」。
   */
  | { ev: 'thinking-delta'; text: string }
  /** 当前思考块结束(含耗时),前端据此把 live 思考卡收起为一行 */
  | { ev: 'thinking-end'; durationMs: number }
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
  | { ev: 'question'; requestId: string; questions: QuestionSpec[] }
  | { ev: 'question-answered'; requestId: string; answers: Record<string, string> }
  | { ev: 'result'; costUsd: number; contextTokens: number; contextPct: number; durationMs: number }
  | { ev: 'rate-limit'; kind: string; utilization: number; resetsAt?: number; model?: string }
  | { ev: 'context'; pct: number }
  | { ev: 'user-echo'; text: string; images?: InlineImage[] }
  | { ev: 'forked'; from: string; to: string }
  | { ev: 'model-changed'; model: string }
  | { ev: 'compact'; trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number }
  | { ev: 'error'; message: string };

/** 上下文窗口兜底值(200K)。真实值随模型而变(如 claude-opus-5[1m] 为 1M),
 *  由 result 消息的 modelUsage[model].contextWindow 覆盖,见 consume() 的 case 'result'。 */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** AskUserQuestion 的问题结构(agent 提问 ≠ 权限审批,渲染为提问卡) */
export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** 派发会话创建参数(WS start / 定时任务 / 周报草稿共用) */
export interface DispatchOpts {
  cwd: string;
  permissionMode?: string;
  model?: string;
  /** 思考深度(SDK effort)。省略 = 用模型自身默认(通常 high) */
  effort?: EffortLevel;
  resume?: string;
  fork?: boolean;
  name?: string;
}

const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 外部输入(WS 消息 / REST body)转 EffortLevel:非法值一律当未指定,不让脏值传进 SDK */
export function parseEffort(v: unknown): EffortLevel | undefined {
  return typeof v === 'string' && EFFORT_LEVELS.includes(v) ? (v as EffortLevel) : undefined;
}

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
  /** 续接来源会话:sessionId 尚未 init 时,attach 垫历史用它定位 jsonl */
  readonly resumeFrom: string | null;
  private fork: boolean;
  readonly startedAt = Date.now();
  /** 最近一次 status 事件,供会话看板注入实时状态 */
  state: 'working' | 'awaiting-permission' | 'idle' | 'ended' = 'working';
  stateDetail: string | undefined;
  /** 最近一次产出时间(回合结束/错误):看板「待验收」标记的比较基准 */
  lastOutputAt: number | null = null;
  /** 最近活动摘要:运行中 = 正在执行的工具,空闲 = 最后一条回复的开头 */
  activity: string | undefined;
  /** SDK 子进程 stderr 尾部环形缓冲:进程异常退出时是唯一的真实报错来源 */
  private stderrTail: string[] = [];
  /** 顶层轮次是否已收到 result:决定 background_tasks_changed 到达时要不要压制/恢复 idle */
  private turnEnded = false;
  /**
   * SDK 权威信号(system/background_tasks_changed,replace 语义)里存活的后台任务
   * (Agent run_in_background 探索子代理、Ctrl+B 转后台的 Bash 等)。顶层轮次结束时若这里非空,
   * 说明还有后台工作在跑,不能把看板打成「空闲」掩盖掉——不靠猜测工具名/完成时机,直接读 SDK 的权威集合。
   */
  private backgroundTasks: { task_id: string; task_type: string; description: string }[] = [];
  /** 本会话实际的上下文窗口大小(token)。首个 result 到达前用兜底值,之后以 SDK 上报的为准 */
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  /** 当前未闭合思考块的 content_block 下标(null = 不在思考中) */
  private thinkingIndex: number | null = null;
  /** 当前思考块的起始时刻,用于给 thinking-end 计算耗时 */
  private thinkingStartAt: number | null = null;

  constructor(storage: Storage, opts: DispatchOpts) {
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
        // 思考深度:与 model 一样是会话级设定,SDK 无运行时 setEffort,只能建会话时定
        effort: opts.effort,
        permissionMode: (opts.permissionMode as never) ?? 'default',
        resume: opts.resume,
        // bg 后台代理会话归 daemon 所有,CLI 拒绝直接 --resume,只能分叉副本续接
        forkSession: opts.fork || undefined,
        includePartialMessages: true,
        /**
         * 思考过程展示开关。不传时 SDK 默认等价于 display:'omitted' —— thinking_delta 事件照发,
         * 但明文被服务端剥成空串只剩 signature 密文(实测:40 个最新会话 2158 个思考块,2119 个明文为空)。
         * 必须显式 summarized 才拿得到明文。adaptive = 由模型自行决定是否思考及思考多少,
         * 简单任务零思考、复杂任务可在一轮内产生多段思考(实测桥问题 4 段,与工具调用交替)。
         */
        thinking: { type: 'adaptive', display: 'summarized' },
        /**
         * 必须显式选 claude_code 预设。不传时 SDK 只发一句兜底提示(实测拦截控制协议报文:
         * `{"subtype":"initialize","systemPrompt":[""]}`,模型自报首句为
         * "You are a Claude agent, built on Anthropic's Claude Agent SDK."),Claude Code 那套行为规范
         * (工具使用纪律、代码风格、commit 约束、拒绝边界)全部缺席,派发会话行为与终端不一致。
         * 预设约 6.5K token(实测总输入 25.1K → 31.7K),走提示缓存,多轮下成本可忽略。
         */
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // 与终端一致的 user 级 skills / MCP / CLAUDE.md(含项目级)
        settingSources: ['user', 'project', 'local'],
        // 标记「璇玑派发」身份:配合项目 CLAUDE.md 的防自斩规则(派发会话禁止重启宿主后端)
        env: { ...process.env, XUANJI_DISPATCH: '1' },
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
    if (e.ev === 'result' || e.ev === 'error') this.lastOutputAt = Date.now();
    if (e.ev === 'tool') this.activity = `${e.name}: ${e.input.replace(/\s+/g, ' ').slice(0, 90)}`;
    if (e.ev === 'assistant') this.activity = e.text.replace(/\s+/g, ' ').slice(0, 110);
    // 状态快照落库:后端重启后看板据此还原(空闲可续接/待验收/活动摘要都不丢)
    if (this.sessionId && (e.ev === 'status' || e.ev === 'result' || e.ev === 'error')) {
      this.storage.updateDispatchState(this.sessionId, this.state, this.lastOutputAt ?? undefined, this.activity);
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
              this.storage.recordDispatch(msg.session_id, this.cwd, this.name);
              this.emit({ ev: 'init', sessionId: msg.session_id, model: (msg as { model?: string }).model ?? '' });
              if (this.fork && this.resumeFrom && msg.session_id !== this.resumeFrom) {
                this.emit({ ev: 'forked', from: this.resumeFrom, to: msg.session_id });
              }
              this.emit({ ev: 'status', state: 'working' });
              this.refreshChips();
            } else if (msg.subtype === 'background_tasks_changed') {
              // 存活后台任务的全量快照(REPLACE 语义):顶层轮次已结束时据此决定是否压制 idle
              this.backgroundTasks =
                (msg as { tasks?: { task_id: string; task_type: string; description: string }[] }).tasks ?? [];
              this.applyBackgroundState();
            } else if (msg.subtype === 'status' && msg.status === 'compacting') {
              // /compact(用户手动输入,或 SDK 到阈值自动触发):压缩期间无 delta/assistant 事件,
              // 靠 status detail 让看板"working"态不显得像卡死
              this.emit({ ev: 'status', state: 'working', detail: '正在压缩上下文…' });
            } else if (msg.subtype === 'compact_boundary') {
              // 压缩成功才会有这条(见 compact_metadata.trigger);失败(如"消息数不足")走的是
              // 合成 assistant 文本回复(下面 case 'assistant' 已覆盖),这里不重复提示避免报两遍
              const meta = msg.compact_metadata;
              this.emit({
                ev: 'compact',
                trigger: meta.trigger,
                preTokens: meta.pre_tokens,
                postTokens: meta.post_tokens,
              });
            }
            break;
          case 'stream_event': {
            const ev = msg.event as {
              type?: string;
              index?: number;
              content_block?: { type?: string };
              delta?: { type?: string; text?: string; thinking?: string };
            };
            if (ev.type === 'content_block_start') {
              // index 在每条 assistant 消息内从 0 重新计数(实测 thinking@0 → tool_use@1 → thinking@0),
              // 故只记「当前未闭合的思考块」下标,不做跨消息的全局映射。
              // 非 thinking 块开始时清账:思考块若因中断没等到 stop,残留下标会让后续同号
              // 块的 stop 误判成思考结束。
              if (ev.content_block?.type === 'thinking') {
                this.thinkingIndex = ev.index ?? null;
                this.thinkingStartAt = Date.now();
              } else {
                this.thinkingIndex = null;
                this.thinkingStartAt = null;
              }
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              this.emit({ ev: 'delta', text: ev.delta.text });
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              this.emit({ ev: 'thinking-delta', text: ev.delta.thinking });
            } else if (ev.type === 'content_block_stop' && this.thinkingIndex !== null && ev.index === this.thinkingIndex) {
              this.emit({ ev: 'thinking-end', durationMs: Date.now() - (this.thinkingStartAt ?? Date.now()) });
              this.thinkingIndex = null;
              this.thinkingStartAt = null;
            }
            break;
          }
          case 'assistant': {
            const blocks = (msg.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
            for (const b of blocks) {
              if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                this.emit({ ev: 'assistant', text: b.text });
              } else if (b.type === 'tool_use' && b.name !== 'AskUserQuestion') {
                // AskUserQuestion 单独走 onPermission → 'question' 事件渲染成提问卡(见下),
                // 这里若照常 emit 通用 'tool' 事件,会在提问卡上方多出一张重复的原始 JSON 工具卡
                // (compact() 500 字符截断还会把 JSON 切成语法不完整的半截),观感像"坏了/context 丢了"。
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
            // 窗口大小随模型而变(opus-5 = 200K,opus-5[1m] = 1M),不能写死:
            // 取本轮 modelUsage 里最大的 contextWindow(一轮内可能跨模型,如主模型 + 子代理小模型)
            const windows = Object.values(
              (msg as unknown as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage ?? {},
            )
              .map((u) => u.contextWindow ?? 0)
              .filter((n) => n > 0);
            if (windows.length > 0) this.contextWindow = Math.max(...windows);
            const contextTokens =
              (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            this.emit({
              ev: 'result',
              costUsd: (msg as { total_cost_usd?: number }).total_cost_usd ?? 0,
              contextTokens,
              contextPct: Math.min(100, Math.round((contextTokens / this.contextWindow) * 100)),
              durationMs: (msg as { duration_ms?: number }).duration_ms ?? 0,
            });
            this.turnEnded = true;
            this.applyBackgroundState();
            this.refreshChips();
            notifyMac(
              this.name,
              this.backgroundTasks.length > 0
                ? `回合完成,${this.backgroundTasks.length} 个后台任务仍在执行`
                : '回合完成,等待你的下一步指示',
            );
            break;
          }
          case 'rate_limit_event': {
            const info = (msg as { rate_limit_info?: { rateLimitType?: string; utilization?: number; resetsAt?: number } })
              .rate_limit_info;
            if (info?.rateLimitType && typeof info.utilization === 'number') {
              this.emit({
                ev: 'rate-limit',
                kind: info.rateLimitType,
                utilization: Math.max(0, Math.min(100, info.utilization)),
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

  /**
   * result 之后的真实状态:仍有存活后台任务(如 run_in_background 探索子代理)时不打纯 idle,
   * 保持看板「运行中」并把 activity 换成后台任务摘要;全部结束后(下一次 background_tasks_changed
   * 携带空集合)才真正转 idle。只在顶层轮次已结束时生效,避免打断本轮内正常的 working/审批流转。
   */
  private applyBackgroundState() {
    if (!this.turnEnded) return;
    if (this.backgroundTasks.length > 0) {
      const label = this.backgroundTasks
        .map((t) => t.description)
        .filter(Boolean)
        .slice(0, 2)
        .join('、');
      this.activity = label ? `后台任务:${label}` : `后台任务执行中(${this.backgroundTasks.length})`;
      this.emit({ ev: 'status', state: 'working' });
    } else {
      this.emit({ ev: 'status', state: 'idle' });
    }
  }

  /**
   * 主动拉取权威用量指示(回合开始/结束时):
   * - getContextUsage → 上下文占用(与终端 /context 同源)
   * - usage 控制请求 → claude.ai 官方 five_hour/seven_day 利用率(0-100)
   * 被动 rate_limit_event 很少出现,不能作为唯一来源。
   */
  private refreshChips() {
    const q = this.q;
    if (!q) return;
    void q
      .getContextUsage()
      .then((cu) => {
        if (typeof cu.percentage === 'number') {
          this.emit({ ev: 'context', pct: Math.max(0, Math.min(100, Math.round(cu.percentage))) });
        }
      })
      .catch(() => {});
    void q
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
      .then((u) => {
        const rl = u.rate_limits;
        if (!u.rate_limits_available || !rl) return;
        for (const kind of ['five_hour', 'seven_day'] as const) {
          const w = rl[kind];
          if (w?.utilization != null) {
            this.emit({
              ev: 'rate-limit',
              kind,
              utilization: Math.max(0, Math.min(100, w.utilization)),
              resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined,
            });
          }
        }
        // 模型级周窗口:优先服务端 model_scoped[](自带 display_name,如 Fable),
        // 缺失时兜底老字段 seven_day_opus。kind 固定 model_weekly,不能以 seven_day 开头——
        // 前端按 startsWith('seven_day') 归并 all-models 条,撞上会互相覆盖。
        const scoped = rl.model_scoped?.find((m) => m.utilization != null);
        const mw = scoped ?? (rl.seven_day_opus?.utilization != null ? rl.seven_day_opus : null);
        if (mw?.utilization != null) {
          this.emit({
            ev: 'rate-limit',
            kind: 'model_weekly',
            utilization: Math.max(0, Math.min(100, mw.utilization)),
            resetsAt: mw.resets_at ? Date.parse(mw.resets_at) : undefined,
            model: scoped ? scoped.display_name : 'Opus',
          });
        }
      })
      .catch(() => {});
  }

  // ---------- 审批 ----------

  private onPermission(
    toolName: string,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[] | undefined,
    title: string | undefined,
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    // AskUserQuestion 也走 canUseTool,但它是提问不是权限——bypassPermissions 也不会(不应)吞掉它
    if (toolName === 'AskUserQuestion' && Array.isArray((input as { questions?: unknown }).questions)) {
      const questions = (input.questions as Array<Record<string, unknown>>).map((q) => ({
        question: String(q.question ?? ''),
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true,
        options: Array.isArray(q.options)
          ? (q.options as Array<Record<string, unknown>>).map((o) => ({
              label: String(o.label ?? ''),
              description: typeof o.description === 'string' ? o.description : undefined,
            }))
          : [],
      }));
      this.emit({ ev: 'status', state: 'awaiting-permission', detail: '回答 Claude 的提问' });
      this.emit({ ev: 'question', requestId, questions });
      notifyMac(this.name, `Claude 有问题问你:${questions[0]?.question.slice(0, 40) ?? ''}`);
      return new Promise<PermissionResult>((resolve) => {
        this.pending.set(requestId, { resolve, toolName, input });
      });
    }
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

  /** 回答 agent 的提问:答案填进 updatedInput.answers(问题 → 答案文本) */
  resolveQuestion(requestId: string, answers: Record<string, string>) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    this.emit({ ev: 'question-answered', requestId, answers });
    this.emit({ ev: 'status', state: 'working' });
    p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers } });
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

  send(text: string, images?: InlineImage[]) {
    // SDK 会话不写 ~/.claude/history.jsonl:prompt 流水记自有库,仪表盘时间线/统计据此补全
    this.storage.recordPrompt(this.cwd, text, this.sessionId ?? undefined);
    this.turnEnded = false; // 新一轮开始:之前 result 后的后台任务压制状态作废,交回正常事件流
    // 图片跟着回显走:user-echo 是所有已连接客户端(含中途 attach 的)唯一的用户消息来源,
    // 发送端若自行本地渲染会与它重复,故图片同走这条链路。
    this.emit({ ev: 'user-echo', text, images });
    this.emit({ ev: 'status', state: 'working' });
    // 无图时保持纯字符串 content(与既有行为一致);有图转 content-block 数组,
    // 图片块排在文字前 —— 模型先看图再读诉求。
    this.input.push({
      type: 'user',
      message: {
        role: 'user',
        content: images?.length
          ? [
              ...images.map((im) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: im.media_type, data: im.data },
              })),
              ...(text ? [{ type: 'text' as const, text }] : []),
            ]
          : text,
      },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  async interrupt() {
    await this.q?.interrupt().catch(() => {});
  }

  /** 中途切换模型(SDK setModel,下一回合生效) */
  async changeModel(model: string) {
    await this.q?.setModel(model);
    this.emit({ ev: 'model-changed', model });
  }

  async end() {
    this.input.close();
    await this.q?.interrupt().catch(() => {});
  }
}

// ---------- 管理器 ----------

const sessions = new Map<string, DispatchSession>();

export function createDispatch(storage: Storage, opts: DispatchOpts): DispatchSession {
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
  lastOutputAt?: number;
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
      // awaiting-permission 时 detail 是审批/提问文案(进 needs);其余状态给最近活动摘要(进卡片 detail)
      detail: s.state === 'awaiting-permission' ? s.stateDetail : s.activity,
      startedAt: s.startedAt,
      lastOutputAt: s.lastOutputAt ?? undefined,
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
