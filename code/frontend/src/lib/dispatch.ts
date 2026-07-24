/** 派发页状态机:/ws/dispatch 双向流 → 消息列表 + agent 状态 + 用量指示 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export type ChatItem =
  | { t: 'user'; text: string }
  | { t: 'assistant'; text: string; streaming: boolean }
  | { t: 'tool'; id: string; name: string; input: string; output?: string; isError?: boolean }
  | { t: 'approval'; requestId: string; toolName: string; title: string; input: string; decision?: string }
  | { t: 'question'; requestId: string; questions: QuestionSpec[]; answers?: Record<string, string> }
  | { t: 'note'; text: string }
  | { t: 'error'; text: string };

export interface AgentStatus {
  state: 'idle' | 'working' | 'awaiting-permission' | 'ended' | 'none';
  detail?: string;
}

export interface UsageChips {
  contextPct: number | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  /** 限额窗口重置时间(ms epoch),悬停显示「还有多久重置」 */
  fiveHourResetsAt: number | null;
  sevenDayResetsAt: number | null;
}

export interface DispatchIntent {
  resume?: { sessionId: string; name: string; cwd: string; project: string };
  /** 后端存活的派发会话:直接 attach 回原事件流(不新开 SDK 会话)。name/project 由发起方(看板已持有的 AgentSession)
   *  随手带过来,省一趟按 dispatchId 反查的请求;派发页只管展示,不关心其来源。 */
  attach?: { dispatchId: string; cwd: string; name: string; project: string };
  prefill?: string;
}

const DISPATCH_KEY = 'xuanji-dispatch-id';
/** 刷新后自动接回:attach 报「不存在」是正常情形(后端已重启),静默清除 */
const GONE_MSG = '派发会话不存在或已结束';

/** 跨视图跳转邮筒:看板「续接」→ 派发页 */
let intentBox: DispatchIntent | null = null;
export function setDispatchIntent(i: DispatchIntent) {
  intentBox = i;
}
export function takeDispatchIntent(): DispatchIntent | null {
  const i = intentBox;
  intentBox = null;
  return i;
}

export interface StartOpts {
  cwd: string;
  permissionMode: string;
  model?: string;
  resume?: string;
  name?: string;
}

export function useDispatch() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ state: 'none' });
  const [chips, setChips] = useState<UsageChips>({ contextPct: null, fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const startedRef = useRef(false);
  const restoringRef = useRef(false);
  // delta 合批:高频 text_delta 逐条 setState 会导致每个 delta 都重渲染整个消息列表并重新
  // 跑一遍 Markdown 解析(ChatRow 见 Dispatch.tsx);渲染跟不上到达速度时,多条 delta 在事件循环
  // 里排队,观感就是"一块块蹦出来"而非打字机。缓冲进 ref,每帧(rAF)合并一次 flush,
  // 把 setState 频率(≤ 屏幕刷新率)与 delta 到达频率解耦。
  const pendingDeltaRef = useRef('');
  const rafIdRef = useRef<number | null>(null);

  const flushDelta = useCallback(() => {
    rafIdRef.current = null;
    const text = pendingDeltaRef.current;
    if (!text) return;
    pendingDeltaRef.current = '';
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.t === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { t: 'assistant', text, streaming: true }];
    });
  }, []);

  /** 清空未 flush 的 delta 缓冲并取消已排的 rAF:reset/attach 重建 items 前必须调用,
   *  否则残留缓冲会在新会话的 items 上多蹦出一条不相干的消息。 */
  const clearPendingDelta = useCallback(() => {
    pendingDeltaRef.current = '';
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const handle = useCallback((e: Record<string, unknown>) => {
    switch (e.ev) {
      case 'attached':
        restoringRef.current = false;
        sessionStorage.setItem(DISPATCH_KEY, String(e.dispatchId));
        break;
      case 'init':
        setSessionId(String(e.sessionId));
        if (e.model) setModel(String(e.model));
        break;
      case 'status':
        setStatus({ state: e.state as AgentStatus['state'], detail: e.detail as string | undefined });
        break;
      case 'user-echo':
        setItems((prev) => [...prev, { t: 'user', text: String(e.text) }]);
        break;
      case 'delta':
        pendingDeltaRef.current += String(e.text);
        if (rafIdRef.current === null) rafIdRef.current = requestAnimationFrame(flushDelta);
        break;
      case 'assistant':
        // 先把缓冲里未 flush 的 delta 并入,保证与最终文本的替换顺序不乱(最终文本本身是权威全文,
        // 是否已并入缓冲不影响正确性,只影响这一帧内 setItems 的调用次数)
        flushDelta();
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last?.t === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), { t: 'assistant', text: String(e.text), streaming: false }];
          }
          return [...prev, { t: 'assistant', text: String(e.text), streaming: false }];
        });
        break;
      case 'tool':
        setItems((prev) => [
          ...prev,
          { t: 'tool', id: String(e.id), name: String(e.name), input: String(e.input) },
        ]);
        break;
      case 'tool-result':
        setItems((prev) =>
          prev.map((it) =>
            it.t === 'tool' && it.id === e.id
              ? { ...it, output: String(e.output), isError: e.isError === true }
              : it,
          ),
        );
        break;
      case 'permission-request':
        setItems((prev) => [
          ...prev,
          {
            t: 'approval',
            requestId: String(e.requestId),
            toolName: String(e.toolName),
            title: String(e.title),
            input: String(e.input),
          },
        ]);
        break;
      case 'question':
        setItems((prev) => [
          ...prev,
          { t: 'question', requestId: String(e.requestId), questions: e.questions as QuestionSpec[] },
        ]);
        break;
      case 'question-answered':
        setItems((prev) =>
          prev.map((it) =>
            it.t === 'question' && it.requestId === e.requestId
              ? { ...it, answers: e.answers as Record<string, string> }
              : it,
          ),
        );
        break;
      case 'permission-resolved':
        setItems((prev) =>
          prev.map((it) =>
            it.t === 'approval' && it.requestId === e.requestId ? { ...it, decision: String(e.decision) } : it,
          ),
        );
        break;
      case 'result':
        setChips((c) => ({ ...c, contextPct: Number(e.contextPct) }));
        setCostUsd((v) => v + Number(e.costUsd ?? 0));
        break;
      case 'context':
        // 后端 getContextUsage() 的权威上下文占用(与终端 /context 同源),覆盖 result 的估算
        setChips((c) => ({ ...c, contextPct: Number(e.pct) }));
        break;
      case 'rate-limit': {
        const pct = Math.round(Number(e.utilization ?? 0)); // 后端统一 0-100
        const resetsAt = typeof e.resetsAt === 'number' ? e.resetsAt : null;
        if (e.kind === 'five_hour') setChips((c) => ({ ...c, fiveHourPct: pct, fiveHourResetsAt: resetsAt }));
        if (String(e.kind).startsWith('seven_day')) setChips((c) => ({ ...c, sevenDayPct: pct, sevenDayResetsAt: resetsAt }));
        break;
      }
      case 'model-changed':
        setModel(String(e.model));
        setItems((prev) => [...prev, { t: 'note', text: `⇄ 模型已切换为 ${String(e.model)},下一回合生效。` }]);
        break;
      case 'forked':
        setItems((prev) => [
          ...prev,
          {
            t: 'note',
            text: `⑂ 原会话归后台代理(--bg)所有,已分叉副本续接(新会话 ${String(e.to).slice(0, 8)},携带完整上下文,原会话不受影响)。`,
          },
        ]);
        break;
      case 'compact': {
        const pre = Number(e.preTokens ?? 0);
        const post = typeof e.postTokens === 'number' ? Number(e.postTokens) : undefined;
        const label = e.trigger === 'auto' ? '上下文自动压缩' : '上下文已压缩';
        const stat = post != null ? `:${pre.toLocaleString()} → ${post.toLocaleString()} tokens` : '';
        setItems((prev) => [...prev, { t: 'note', text: `🗜 ${label}${stat}` }]);
        break;
      }
      case 'bg-dispatched':
        setItems((prev) => [
          ...prev,
          {
            t: 'note',
            text: e.ok
              ? '⇢ 已转后台(claude --bg),由 daemon 托管。可在「会话」看板跟踪进度。'
              : `后台派发失败:${e.output}`,
          },
        ]);
        break;
      case 'error':
        if (restoringRef.current && e.message === GONE_MSG) {
          // 刷新自动接回失败(后端已重启):静默回到全新状态
          restoringRef.current = false;
          startedRef.current = false;
          sessionStorage.removeItem(DISPATCH_KEY);
          break;
        }
        setItems((prev) => [...prev, { t: 'error', text: String(e.message) }]);
        setStatus({ state: 'idle' });
        break;
    }
  }, [flushDelta]);

  const attachRef = useRef<((dispatchId: string) => Promise<void>) | null>(null);

  const ensureWs = useCallback((): Promise<WebSocket> => {
    const cur = wsRef.current;
    if (cur && cur.readyState === WebSocket.OPEN) return Promise.resolve(cur);
    return new Promise((resolve, reject) => {
      const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${wsProto}://${location.host}/ws/dispatch`);
      wsRef.current = ws;
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error('派发通道连接失败'));
      ws.onmessage = (m) => {
        try {
          handle(JSON.parse(m.data));
        } catch {
          /* ignore */
        }
      };
      // 静默断开(窗口挂起/后端重启)→ 自动接回:会话在后端存活,attach 全量回放补齐错过的事件
      ws.onclose = () => {
        if (wsRef.current !== ws) return; // 主动 reset / 已换新连接
        wsRef.current = null;
        const saved = sessionStorage.getItem(DISPATCH_KEY);
        if (!startedRef.current || !saved) return;
        const retry = () => {
          restoringRef.current = true;
          attachRef.current?.(saved).catch(() => setTimeout(retry, 3000));
        };
        setTimeout(retry, 800);
      };
    });
  }, [handle]);

  useEffect(() => () => {
    wsRef.current?.close();
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
  }, []);

  /** attach 到后端存活的派发会话(看板点击 / 刷新或断线自动接回),事件流全量回放重建 */
  const attach = useCallback(
    async (dispatchId: string) => {
      startedRef.current = true;
      clearPendingDelta();
      // 服务端回放全部事件,先清空避免重复
      setItems([]);
      setStatus({ state: 'none' });
      setCostUsd(0);
      setChips({ contextPct: null, fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null });
      const ws = await ensureWs();
      ws.send(JSON.stringify({ op: 'attach', dispatchId }));
    },
    [ensureWs, clearPendingDelta],
  );
  attachRef.current = attach;

  // 刷新自动接回:本 tab 曾有派发会话且后端仍存活 → 静默重建
  useEffect(() => {
    const saved = sessionStorage.getItem(DISPATCH_KEY);
    if (saved && !startedRef.current) {
      restoringRef.current = true;
      void attach(saved).catch(() => {
        restoringRef.current = false;
        startedRef.current = false;
      });
    }
  }, [attach]);

  const send = useCallback(
    async (text: string, opts: StartOpts & { bg?: boolean }) => {
      const ws = await ensureWs();
      if (opts.bg) {
        setItems((prev) => [...prev, { t: 'user', text }]);
        ws.send(JSON.stringify({ op: 'bg', cwd: opts.cwd, prompt: text }));
        return;
      }
      if (!startedRef.current) {
        startedRef.current = true;
        setStatus({ state: 'working' });
        ws.send(
          JSON.stringify({
            op: 'start',
            cwd: opts.cwd,
            permissionMode: opts.permissionMode,
            model: opts.model,
            resume: opts.resume,
            name: opts.name,
            prompt: text,
          }),
        );
      } else {
        ws.send(JSON.stringify({ op: 'send', text }));
      }
    },
    [ensureWs],
  );

  const decide = useCallback((requestId: string, decision: 'allow' | 'always' | 'deny') => {
    wsRef.current?.send(JSON.stringify({ op: 'permission', requestId, decision }));
  }, []);

  const answer = useCallback((requestId: string, answers: Record<string, string>) => {
    wsRef.current?.send(JSON.stringify({ op: 'answer', requestId, answers }));
  }, []);

  const interrupt = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ op: 'interrupt' }));
  }, []);

  const changeModel = useCallback((model: string) => {
    wsRef.current?.send(JSON.stringify({ op: 'model', model }));
  }, []);

  const reset = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    startedRef.current = false;
    restoringRef.current = false;
    clearPendingDelta();
    sessionStorage.removeItem(DISPATCH_KEY);
    setItems([]);
    setStatus({ state: 'none' });
    setSessionId(null);
    setModel(null);
    setCostUsd(0);
    setChips({ contextPct: null, fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null });
  }, [clearPendingDelta]);

  const pushNote = useCallback((text: string) => {
    setItems((prev) => [...prev, { t: 'note', text }]);
  }, []);

  /** 续接前装载历史对话(来自只读回放),插在当前消息之前 */
  const seedHistory = useCallback((history: ChatItem[]) => {
    setItems((prev) => [...history, ...prev]);
  }, []);

  const started = startedRef.current;
  return { items, status, chips, sessionId, model, costUsd, started, send, attach, decide, answer, interrupt, changeModel, reset, pushNote, seedHistory };
}
