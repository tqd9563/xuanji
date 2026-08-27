/**
 * 验收面板的前端状态:清单拉取 + 执行/停止 + 日志与状态灯的实时流。
 *
 * 为什么自己开一条 /ws/dispatch 连接而不挤进 useDispatch:
 * 面板要在会话早已结束(review 态、后端重启过)时照样能用,而 useDispatch 的状态机
 * 是围绕「活着的派发会话」构建的。两者耦在一起,面板就得跟着会话生命周期走——
 * 那正是 attach 路径反复漏动作的老问题(memory: attach 是 resume 的手抄副本)。
 * 后端对每条连接独立处理,面板这条只发 rb-* 三个 op,互不牵连。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface RunbookParam {
  key: string;
  label: string;
  type: 'string' | 'date' | 'number' | 'boolean' | 'enum';
  required?: boolean;
  default?: string;
  options?: string[];
  description?: string;
  flag?: string;
}

export interface RunbookLink {
  title: string;
  url: string;
}

export type RunbookItemType = 'service' | 'command' | 'request' | 'link' | 'cleanup';
export type RunbookRunStatus = 'running' | 'ready' | 'exited' | 'failed' | 'stopped' | 'ok';

export interface RunbookItem {
  id: string;
  type: RunbookItemType;
  title: string;
  description?: string;
  origin: 'template' | 'session';
  command?: string;
  params?: RunbookParam[];
  links?: RunbookLink[];
  dependsOn?: string[];
  method?: string;
  url?: string;
  body?: string;
  expect?: string;
  /** 后端渲染时就判定好的黑名单拦截原因(不等点击才报错) */
  blockedReason?: string;
}

export interface RunbookRun {
  id: number;
  itemId: string;
  resolvedCommand: string;
  status: RunbookRunStatus;
  exitCode: number | null;
}

export interface ResolvedRunbook {
  sessionId: string;
  cwd: string;
  templateName?: string;
  templateVersion?: number;
  notes?: string;
  items: RunbookItem[];
  runs: Record<string, RunbookRun>;
}

export interface RequestOutcome {
  ok: boolean;
  status?: number;
  durationMs?: number;
  body?: string;
  reason?: string;
}

/** 参数取值:用户本次输入 > 会话预填/模板 default */
export function paramValue(p: RunbookParam, edited?: Record<string, string>): string {
  return edited?.[p.key] ?? p.default ?? '';
}

/**
 * 前端侧的命令回显。与后端 resolveCommand 同规则,但**只用于展示**——
 * 真正执行的命令由后端重新插值,前端算错也不会执行到别的东西。
 */
export function previewCommand(item: RunbookItem, edited?: Record<string, string>): string {
  let display = item.command ?? '';
  const appended: string[] = [];
  for (const p of item.params ?? []) {
    const raw = paramValue(p, edited);
    const ph = `{{${p.key}}}`;
    if (p.type === 'boolean') {
      const on = raw === 'true';
      if (display.includes(ph)) display = display.split(ph).join(on && p.flag ? p.flag : '');
      else if (on && p.flag) appended.push(p.flag);
      continue;
    }
    if (display.includes(ph)) display = display.split(ph).join(raw);
    else if (p.flag) {
      if (raw !== '') appended.push(p.flag, raw);
    } else if (raw !== '') appended.push(raw);
  }
  return [display, ...appended].join(' ').replace(/\s+/g, ' ').trim();
}

/** 依赖项是否已就绪:软约束,只影响按钮可用性,不做自动编排 */
export function depsReady(item: RunbookItem, runs: Record<string, RunbookRun>): boolean {
  return (item.dependsOn ?? []).every((id) => {
    const s = runs[id]?.status;
    return s === 'ready' || s === 'ok';
  });
}

export function useRunbook(sessionId: string | null) {
  const [runbook, setRunbook] = useState<ResolvedRunbook | null>(null);
  const [runs, setRuns] = useState<Record<string, RunbookRun>>({});
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const wsRef = useRef<WebSocket | null>(null);

  const load = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/sessions/${sid}/runbook`);
      if (!res.ok) return setRunbook(null);
      const data = (await res.json()) as { runbook: ResolvedRunbook | null };
      setRunbook(data.runbook);
      setRuns(data.runbook?.runs ?? {});
    } catch {
      setRunbook(null);
    }
  }, []);

  // 会话切换:重新拉清单并把上一会话的日志/错误清干净(否则会串台)
  useEffect(() => {
    setLogs({});
    setErrors({});
    setRuns({});
    if (!sessionId) return setRunbook(null);
    void load(sessionId);
  }, [sessionId, load]);

  // 实时通道:订阅本会话的状态灯与日志
  useEffect(() => {
    if (!sessionId) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/dispatch`);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ op: 'rb-watch', sessionId }));
    ws.onmessage = (m) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(m.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      const itemId = String(e.itemId ?? '');
      if (e.ev === 'rb-state') {
        setRuns((prev) => ({
          ...prev,
          [itemId]: {
            id: Number(e.runId),
            itemId,
            resolvedCommand: prev[itemId]?.resolvedCommand ?? '',
            status: e.status as RunbookRunStatus,
            exitCode: (e.exitCode as number | null) ?? null,
          },
        }));
        // 新一轮开跑就清掉上一轮的日志与报错,不然新旧输出叠在一起没法看
        if (e.status === 'running') {
          setLogs((prev) => ({ ...prev, [itemId]: '' }));
          setErrors((prev) => ({ ...prev, [itemId]: '' }));
        }
      } else if (e.ev === 'rb-log') {
        setLogs((prev) => ({ ...prev, [itemId]: (prev[itemId] ?? '') + String(e.chunk) }));
      } else if (e.ev === 'rb-error') {
        setErrors((prev) => ({ ...prev, [itemId]: String(e.message) }));
      }
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [sessionId]);

  const run = useCallback(
    (item: RunbookItem, params: Record<string, string>, confirmed: boolean) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !runbook) return;
      ws.send(
        JSON.stringify({ op: 'rb-run', sessionId: runbook.sessionId, cwd: runbook.cwd, itemId: item.id, params, confirmed }),
      );
    },
    [runbook],
  );

  const stop = useCallback(
    (item: RunbookItem) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !runbook) return;
      ws.send(JSON.stringify({ op: 'rb-stop', sessionId: runbook.sessionId, itemId: item.id }));
    },
    [runbook],
  );

  /** 预置请求走 REST:一问一答,没有流式输出 */
  const sendRequest = useCallback(
    async (item: RunbookItem, confirmed: boolean): Promise<RequestOutcome> => {
      if (!runbook) return { ok: false, reason: '面板未就绪' };
      try {
        const res = await fetch(`/api/sessions/${runbook.sessionId}/runbook/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ itemId: item.id, confirmed }),
        });
        return (await res.json()) as RequestOutcome;
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    [runbook],
  );

  return { runbook, runs, logs, errors, run, stop, sendRequest, reload: load };
}
