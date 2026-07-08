/** 派发页状态机:/ws/dispatch 双向流 → 消息列表 + agent 状态 + 用量指示 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ChatItem =
  | { t: 'user'; text: string }
  | { t: 'assistant'; text: string; streaming: boolean }
  | { t: 'tool'; id: string; name: string; input: string; output?: string; isError?: boolean }
  | { t: 'approval'; requestId: string; toolName: string; title: string; input: string; decision?: string }
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
}

export interface DispatchIntent {
  resume?: { sessionId: string; name: string; cwd: string };
  prefill?: string;
}

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
  const [chips, setChips] = useState<UsageChips>({ contextPct: null, fiveHourPct: null, sevenDayPct: null });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const startedRef = useRef(false);

  const handle = useCallback((e: Record<string, unknown>) => {
    switch (e.ev) {
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
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last?.t === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, text: last.text + String(e.text) }];
          }
          return [...prev, { t: 'assistant', text: String(e.text), streaming: true }];
        });
        break;
      case 'assistant':
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
      case 'rate-limit': {
        const pct = Math.round(Number(e.utilization ?? 0) * 100);
        if (e.kind === 'five_hour') setChips((c) => ({ ...c, fiveHourPct: pct }));
        if (String(e.kind).startsWith('seven_day')) setChips((c) => ({ ...c, sevenDayPct: pct }));
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
        setItems((prev) => [...prev, { t: 'error', text: String(e.message) }]);
        setStatus({ state: 'idle' });
        break;
    }
  }, []);

  const ensureWs = useCallback((): Promise<WebSocket> => {
    const cur = wsRef.current;
    if (cur && cur.readyState === WebSocket.OPEN) return Promise.resolve(cur);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${location.host}/ws/dispatch`);
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
    });
  }, [handle]);

  useEffect(() => () => wsRef.current?.close(), []);

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

  const interrupt = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ op: 'interrupt' }));
  }, []);

  const reset = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    startedRef.current = false;
    setItems([]);
    setStatus({ state: 'none' });
    setSessionId(null);
    setModel(null);
    setCostUsd(0);
    setChips({ contextPct: null, fiveHourPct: null, sevenDayPct: null });
  }, []);

  const pushNote = useCallback((text: string) => {
    setItems((prev) => [...prev, { t: 'note', text }]);
  }, []);

  const started = startedRef.current;
  return { items, status, chips, sessionId, model, costUsd, started, send, decide, interrupt, reset, pushNote };
}
