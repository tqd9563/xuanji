/** 派发页状态机:/ws/dispatch 双向流 → 消息列表 + agent 状态 + 用量指示 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { SideQuestion } from '@/api/types';
import type { SlashCmdInfo } from '@/lib/slash';

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** 消息发送时间(ms epoch)。实时消息在到达时打点,历史消息取 session jsonl 的 ts;
 *  工具卡/审批等非对话事件无此字段(源数据本就没有时间),不显示时间也不参与跨天分隔。 */
/** 随消息内联发送的图片(输入框里粘贴的截图)。data 是不带 data: 前缀的 base64。 */
export interface InlineImage {
  media_type: string;
  data: string;
}

/** 聊天行的稳定 key:历史前插不改变已有行的 key(历史行为负数,实时行从 0 起) */
export function chatKey(index: number, seedOffset: number): number {
  return index - seedOffset;
}

export type ChatItem =
  | { t: 'user'; text: string; ts?: number; images?: InlineImage[] }
  /** turnMs:本轮(你发出 → 回合结束)总耗时,回合结束时打在该轮最后一条 assistant 上 */
  | { t: 'assistant'; text: string; streaming: boolean; ts?: number; turnMs?: number }
  /** 思考块:streaming 时展开逐字流出,收到 thinking-end 后带耗时收起为一行 */
  | { t: 'thinking'; text: string; streaming: boolean; durationMs?: number }
  | { t: 'tool'; id: string; name: string; input: string; output?: string; isError?: boolean }
  | { t: 'approval'; requestId: string; toolName: string; title: string; input: string; decision?: string }
  | { t: 'question'; requestId: string; questions: QuestionSpec[]; answers?: Record<string, string> }
  | { t: 'note'; text: string }
  /** PR/MR 链接卡:回放装载历史时出现,实时流无此事件 */
  | { t: 'pr'; url: string; platform: 'gitlab' | 'github' | 'other'; number?: number; repo?: string; updates: number; ts?: number; lastTs?: number }
  /** 上下文压缩点:历史装载时带摘要可展开;实时压缩事件无摘要则仅一行 */
  | { t: 'compact'; trigger?: string; preTokens?: number; durationMs?: number; summary?: string }
  | { t: 'error'; text: string };

/**
 * 旁路提问(/btw)状态:与主对话 items 完全隔离——答案落这里与自有库,永不进 items。
 * records 按时间正序(面板 ⇧←/⇧→ 的翻页顺序);会话 init/attach 时从后端拉全量,之后由 btw-result 追加。
 */
export interface BtwState {
  /** records 属于哪个会话。跨会话残留是本状态的历史缺陷(见拉取 effect),归属显式化后一眼可判 */
  sessionId: string | null;
  inFlight: { requestId: string; question: string; startedAt: number } | null;
  records: SideQuestion[];
  /** 最近一次失败(含取消):面板据此显示重问/改到主对话问 */
  error: { requestId: string; question: string; message: string } | null;
}

const BTW_EMPTY: BtwState = { sessionId: null, inFlight: null, records: [], error: null };

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
  /** 模型级周窗口(如 Fable 单独配额):与 seven_day 同一重置时刻,利用率独立;服务端未下发时保持 null */
  modelWeeklyPct: number | null;
  modelWeeklyName: string | null;
}

export interface DispatchIntent {
  resume?: { sessionId: string; name: string; cwd: string; project: string };
  /** 后端存活的派发会话:直接 attach 回原事件流(不新开 SDK 会话)。name/project/sessionId 由发起方(看板已持有的
   *  AgentSession)随手带过来,省一趟按 dispatchId 反查的请求;派发页只管展示,不关心其来源。
   *  sessionId 仅用于进入时标已读(会话标识里的 id 仍等 attach 重放 init 事件后补)。 */
  attach?: { dispatchId: string; sessionId: string; cwd: string; name: string; project: string };
  prefill?: string;
  /** 全新派发的工作目录(待办「开工」带过来;attach/resume 自带 cwd,不走这里) */
  cwd?: string;
  /** 由哪条待办发起:会话拿到 sessionId 后回填给这条待办(状态转「进行中」并挂上锚点) */
  todoId?: number;
}

const DISPATCH_KEY = 'xuanji-dispatch-id';
/** 事件发生的时刻:attach 回放的事件带 at(当初入缓冲的时刻),实时事件没有 → 现在。
 *  不用它的话,接回/刷新后整条会话的消息时间会被抹成同一个「刚刚」。 */
export function evAt(e: Record<string, unknown>): number {
  const at = Number(e.at);
  return Number.isFinite(at) && at > 0 ? at : Date.now();
}

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
  /** 思考深度(low/medium/high/xhigh/max)。只在建会话时生效,SDK 无运行时切换 */
  effort?: string;
  resume?: string;
  name?: string;
}

/**
 * 收束仍在 streaming 的思考卡:正文/工具一旦开始,思考必然已结束。
 * thinking-end 正常会先到,这里兜的是它没到的情形(轮次被中断、块未闭合),
 * 否则思考卡会永远停在「进行中」转圈。
 */
function sealThinking(prev: ChatItem[]): ChatItem[] {
  const last = prev[prev.length - 1];
  if (last?.t === 'thinking' && last.streaming) {
    return [...prev.slice(0, -1), { ...last, streaming: false }];
  }
  return prev;
}

export function useDispatch() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ state: 'none' });
  const [chips, setChips] = useState<UsageChips>({ contextPct: null, fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null, modelWeeklyPct: null, modelWeeklyName: null });
  const [sessionId, setSessionId] = useState<string | null>(null);
  /**
   * 「已知会话 id」:续接/接回时前端其实早就知道要进哪个会话,但 sessionId 要等 SDK 的 init 事件
   * (= 发出第一条消息之后)才有值。旁路记录这类「按会话挂载的自有数据」不该陪着等那一轮,
   * 故进入会话的入口把 id 先登记在这里;init 到了以它为准(fork 会换 id)。
   */
  const [knownSessionId, setKnownSessionId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  /** 本轮耗时:startedAt 进 working 时起算(审批等待也算在轮内,与 SDK 的 durationMs 同口径),
   *  lastMs 由 result 事件的权威值定格。状态条读它显示「已用 N」/「本轮 N」。 */
  const [turn, setTurn] = useState<{ startedAt: number | null; lastMs: number | null }>({ startedAt: null, lastMs: null });
  /** 「你按下发送」的时刻。只由本前端的 send 置位——接回存活会话、装载历史回放时都没有这个动作,
   *  那些场景的 result 必须退回 SDK 的 duration_ms,否则会把回放事件当成刚跑完的一轮算出 0s。 */
  const turnStartRef = useRef<number | null>(null);
  /** 接回存活会话时后端随 attached 事件下发的垫历史元信息:内存事件只覆盖后端本进程
   *  生命周期,before(= dispatch startedAt)之前的对话需从会话 jsonl 回放补齐(消费方 Dispatch.tsx)。
   *  每次 attach 都换新对象引用,重连接回(items 已被清空)也能重新触发消费 effect。 */
  const [attachedHistory, setAttachedHistory] = useState<{ sessionId: string; before: number } | null>(null);
  /** 本会话可用的斜杠命令(联想面板)。后端 commands 事件是 REPLACE 语义,整份换掉即可 */
  const [commands, setCommands] = useState<SlashCmdInfo[] | null>(null);
  /** 命令使用频率(含璇玑自己拦截的那几条),前端的内置命令表按它排序 */
  const [commandUses, setCommandUses] = useState<Record<string, number>>({});
  const [btw, setBtw] = useState<BtwState>(BTW_EMPTY);
  const wsRef = useRef<WebSocket | null>(null);
  const startedRef = useRef(false);
  const restoringRef = useRef(false);
  // delta 合批:高频 text_delta 逐条 setState 会导致每个 delta 都重渲染整个消息列表并重新
  // 跑一遍 Markdown 解析(ChatRow 见 Dispatch.tsx);渲染跟不上到达速度时,多条 delta 在事件循环
  // 里排队,观感就是"一块块蹦出来"而非打字机。缓冲进 ref,每帧(rAF)合并一次 flush,
  // 把 setState 频率(≤ 屏幕刷新率)与 delta 到达频率解耦。
  const pendingDeltaRef = useRef('');
  // 思考流同样是高频 delta(实测一段思考 ~54 条),与正文共用同一个 rAF 节拍合批。
  // 两者不会同时活跃(思考块 stop 后才轮到正文),故一个 rAF 里顺序 flush 即可。
  const pendingThinkRef = useRef('');
  /** 本批 delta 里第一条事件发生的时刻(回放事件的 at,实时则是现在),给合批出的消息打时间 */
  const pendingAtRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const flushDelta = useCallback(() => {
    rafIdRef.current = null;
    const think = pendingThinkRef.current;
    if (think) {
      pendingThinkRef.current = '';
      setItems((prev) => {
        const last = prev[prev.length - 1];
        if (last?.t === 'thinking' && last.streaming) {
          return [...prev.slice(0, -1), { ...last, text: last.text + think }];
        }
        return [...prev, { t: 'thinking', text: think, streaming: true }];
      });
    }
    const text = pendingDeltaRef.current;
    if (!text) return;
    pendingDeltaRef.current = '';
    // 时间取首个 delta 到达时刻(Claude 开始回话),不随后续 delta 推移;
    // 回放事件带 at(当初发生的时刻),用它而不是「现在」。
    // 必须在 setItems 之外先取值:更新函数是延后执行的,接回回放几百条事件连发时 React
    // 来不及在两条之间渲染,更新函数攒到一起才跑,那时 ref 早被下面那行清空(或被后一批
    // delta 改写),整条会话的 Claude 消息就全变成渲染那一刻(2026-09-21 实测:98 条只剩 6 个时刻)
    const at = pendingAtRef.current ?? Date.now();
    pendingAtRef.current = null;
    setItems((prev0) => {
      const prev = sealThinking(prev0);
      const last = prev[prev.length - 1];
      if (last?.t === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { t: 'assistant', text, streaming: true, ts: at }];
    });
  }, []);

  /** 清空未 flush 的 delta 缓冲并取消已排的 rAF:reset/attach 重建 items 前必须调用,
   *  否则残留缓冲会在新会话的 items 上多蹦出一条不相干的消息。 */
  const clearPendingDelta = useCallback(() => {
    pendingDeltaRef.current = '';
    pendingThinkRef.current = '';
    pendingAtRef.current = null;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const handle = useCallback((e: Record<string, unknown>) => {
    switch (e.ev) {
      case 'attached':
        restoringRef.current = false;
        attachingRef.current = false;
        sessionStorage.setItem(DISPATCH_KEY, String(e.dispatchId));
        if (typeof e.historySessionId === 'string' && typeof e.historyBefore === 'number') {
          setAttachedHistory({ sessionId: e.historySessionId, before: e.historyBefore });
        }
        break;
      case 'commands':
        setCommands(e.cmds as SlashCmdInfo[]);
        if (e.uses) setCommandUses(e.uses as Record<string, number>);
        break;
      case 'init':
        setSessionId(String(e.sessionId));
        // 会话真实 id 以 init 为准(续接 fork 会换 id):同步覆盖入口登记的已知 id,
        // 否则旁路记录会继续挂在被 fork 掉的那个旧会话上
        setKnownSessionId(String(e.sessionId));
        if (e.model) setModel(String(e.model));
        break;
      case 'status': {
        const st = e.state as AgentStatus['state'];
        setStatus({ state: st, detail: e.detail as string | undefined });
        // 轮次起点:从「不在跑」转入 working 的那一刻。审批等待(awaiting-permission)不重新起算,
        // 它仍属同一轮——SDK 的 durationMs 也把这段等待算在内。
        // 秒表起点:本前端发的那一轮用 send 的时刻(与定格值同源);终端里发起、这边只是接回
        // 观战的轮次没有发送动作,退而用「转入 working」的时刻,近似但总比不显示强。
        if (st === 'working') {
          const startedAt = turnStartRef.current ?? Date.now();   // 同上:先取值,不在更新函数里读 ref
          setTurn((t) => (t.startedAt == null ? { ...t, startedAt } : t));
        }
        else if (st === 'idle' || st === 'ended' || st === 'none') {
          setTurn((t) => ({ ...t, startedAt: null }));
          // 轮次没收到 result 就结束了(中断 / 报错):起点必须作废,否则会被下一轮当成自己的起点
          turnStartRef.current = null;
        }
        break;
      }
      case 'user-echo':
        setItems((prev) => [
          ...prev,
          { t: 'user', text: String(e.text ?? ''), ts: evAt(e), images: e.images as InlineImage[] | undefined },
        ]);
        break;
      case 'delta':
        pendingAtRef.current ??= evAt(e);
        pendingDeltaRef.current += String(e.text);
        if (rafIdRef.current === null) rafIdRef.current = requestAnimationFrame(flushDelta);
        break;
      case 'thinking-delta':
        pendingAtRef.current ??= evAt(e);
        pendingThinkRef.current += String(e.text);
        if (rafIdRef.current === null) rafIdRef.current = requestAnimationFrame(flushDelta);
        break;
      case 'thinking-end':
        // 先刷掉缓冲里最后一截思考文本,再收起 —— 否则 rAF 尚未触发时残留会丢
        flushDelta();
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last?.t === 'thinking' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, streaming: false, durationMs: Number(e.durationMs) }];
          }
          // 没有对应卡片 = 本轮思考无明文(模型未思考,或 display 未生效被剥成空串):不留占位
          return prev;
        });
        break;
      case 'assistant':
        // 先把缓冲里未 flush 的 delta 并入,保证与最终文本的替换顺序不乱(最终文本本身是权威全文,
        // 是否已并入缓冲不影响正确性,只影响这一帧内 setItems 的调用次数)
        flushDelta();
        setItems((prev0) => {
          const prev = sealThinking(prev0);
          const last = prev[prev.length - 1];
          if (last?.t === 'assistant' && last.streaming) {
            // 保留流开始时打的点,不改写成本轮结束时刻
            return [...prev.slice(0, -1), { t: 'assistant', text: String(e.text), streaming: false, ts: last.ts }];
          }
          return [...prev, { t: 'assistant', text: String(e.text), streaming: false, ts: evAt(e) }];
        });
        break;
      case 'tool':
        setItems((prev) => [
          ...sealThinking(prev),
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
      case 'result': {
        setChips((c) => ({ ...c, contextPct: Number(e.contextPct) }));
        setCostUsd((v) => v + Number(e.costUsd ?? 0));
        // 口径:本前端发出的轮次用墙钟(你按下发送 → 回合结束)。SDK 的 duration_ms 从 query 真正
        // 开跑起算,漏掉会话冷启动那几秒——实测首轮状态条已数到 9s 而 duration_ms 只给 3s,定格
        // 时数字当场跳水。没有发送动作的轮次(接回观战、重连后装载的历史回放)退回 SDK 值。
        const sdkMs = Number(e.durationMs);
        const ms = turnStartRef.current != null ? Date.now() - turnStartRef.current : sdkMs;
        if (Number.isFinite(ms) && ms > 0) {
          setTurn({ startedAt: null, lastMs: ms });
          turnStartRef.current = null;
          // 打在本轮最后一条 assistant 上;该轮若只有工具调用没有正文(极少),就只剩状态条显示
          setItems((prev) => {
            const i = prev.map((it) => it.t).lastIndexOf('assistant');
            if (i < 0) return prev;
            const next = [...prev];
            next[i] = { ...(next[i] as Extract<ChatItem, { t: 'assistant' }>), turnMs: ms };
            return next;
          });
        }
        break;
      }
      case 'context':
        // 后端 getContextUsage() 的权威上下文占用(与终端 /context 同源),覆盖 result 的估算
        setChips((c) => ({ ...c, contextPct: Number(e.pct) }));
        break;
      case 'rate-limit': {
        const pct = Math.round(Number(e.utilization ?? 0)); // 后端统一 0-100
        const resetsAt = typeof e.resetsAt === 'number' ? e.resetsAt : null;
        if (e.kind === 'five_hour') setChips((c) => ({ ...c, fiveHourPct: pct, fiveHourResetsAt: resetsAt }));
        // model_weekly 先于 seven_day 前缀判断:模型级窗口不并入 all-models 条
        if (e.kind === 'model_weekly') {
          setChips((c) => ({ ...c, modelWeeklyPct: pct, modelWeeklyName: typeof e.model === 'string' ? e.model : null }));
        } else if (String(e.kind).startsWith('seven_day')) {
          setChips((c) => ({ ...c, sevenDayPct: pct, sevenDayResetsAt: resetsAt }));
        }
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
        setItems((prev) => [
          ...prev,
          {
            t: 'compact',
            trigger: typeof e.trigger === 'string' ? e.trigger : undefined,
            preTokens: typeof e.preTokens === 'number' ? e.preTokens : undefined,
          },
        ]);
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
      // ---------- 旁路提问:三段式,与主对话 items 互不相干 ----------
      case 'btw-start':
        setBtw((b) => ({
          ...b,
          error: null,
          inFlight: { requestId: String(e.requestId), question: String(e.question), startedAt: Date.now() },
        }));
        break;
      case 'btw-result': {
        const record = e.record as SideQuestion;
        setBtw((b) => ({
          ...b,
          inFlight: null,
          error: null,
          // attach 回放 + 拉库可能各带一份同 id 记录,按 id 去重
          records: b.records.some((r) => r.id === record.id) ? b.records : [...b.records, record],
        }));
        break;
      }
      case 'btw-error':
        setBtw((b) => ({
          ...b,
          inFlight: null,
          error: { requestId: String(e.requestId), question: String(e.question), message: String(e.message) },
        }));
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
  /**
   * 接回期间的回放缓冲。后端 attach 会把内存里的事件流一口气推过来(实测 238 条 53ms 内到齐),
   * 每条 WebSocket 消息都是独立的宏任务,逐条 handle 就是逐条 setState、逐条渲染越来越长的
   * 列表——用户看到的是「点进去要等好几秒才出内容」。攒到 attached 再在同一个任务里顺序
   * 处理,React 18 自动合批成一次渲染。
   */
  const attachingRef = useRef(false);
  const replayBufRef = useRef<Record<string, unknown>[]>([]);

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
          const ev = JSON.parse(m.data) as Record<string, unknown>;
          if (attachingRef.current && ev.ev !== 'attached') {
            replayBufRef.current.push(ev);
            return;
          }
          if (ev.ev === 'attached') {
            const buf = replayBufRef.current;
            replayBufRef.current = [];
            for (const b of buf) handle(b); // 同一任务内:所有 setState 合批
          }
          handle(ev);
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
      attachingRef.current = true;
      replayBufRef.current = [];
      seedOffsetRef.current = 0;
      // 服务端回放全部事件,先清空避免重复
      setItems([]);
      setStatus({ state: 'none' });
      setCostUsd(0);
      setTurn({ startedAt: null, lastMs: null });
    turnStartRef.current = null;
      turnStartRef.current = null;
      setChips({ contextPct: null, fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null, modelWeeklyPct: null, modelWeeklyName: null });
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
    async (text: string, opts: StartOpts & { bg?: boolean; images?: InlineImage[] }) => {
      const ws = await ensureWs();
      const images = opts.images?.length ? opts.images : undefined;
      if (opts.bg) {
        // 后台会话走 claude CLI 子进程,没有内联图片通道 —— 图片在此丢弃(UI 已提前拦截)
        setItems((prev) => [...prev, { t: 'user', text }]);
        ws.send(JSON.stringify({ op: 'bg', cwd: opts.cwd, prompt: text }));
        return;   // 后台会话不在本页跑,没有 result 事件可收口,故不起表
      }
      turnStartRef.current = Date.now();   // 轮次计时从「按下发送」起算
      if (!startedRef.current) {
        startedRef.current = true;
        setStatus({ state: 'working' });
        ws.send(
          JSON.stringify({
            op: 'start',
            cwd: opts.cwd,
            permissionMode: opts.permissionMode,
            model: opts.model,
            effort: opts.effort,
            resume: opts.resume,
            name: opts.name,
            prompt: text,
            images,
          }),
        );
      } else {
        ws.send(JSON.stringify({ op: 'send', text, images }));
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
    seedOffsetRef.current = 0;
    setSeedOffset(0);
    attachingRef.current = false;
    replayBufRef.current = [];
    wsRef.current?.close();
    wsRef.current = null;
    startedRef.current = false;
    restoringRef.current = false;
    clearPendingDelta();
    sessionStorage.removeItem(DISPATCH_KEY);
    setItems([]);
    setStatus({ state: 'none' });
    setSessionId(null);
    setKnownSessionId(null);
    setModel(null);
    setCostUsd(0);
    setTurn({ startedAt: null, lastMs: null });
    setChips({ contextPct: null, fiveHourPct: null, sevenDayPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null, modelWeeklyPct: null, modelWeeklyName: null });
    setAttachedHistory(null);
    // commands 有意不清:命令目录跨会话基本不变,留着新会话就不必空一轮等 init,
    // 真列表一到自会整份替换(REPLACE 语义)
    setBtw(BTW_EMPTY);
  }, [clearPendingDelta]);

  /** 拉旁路记录用的会话 id:入口登记的已知 id 最权威(续接/接回进入的就是它),
   *  没登记过才退回 SDK init 给的 sessionId(全新派发 / fork 换 id 都属此列)。
   *  2026-09-20:反过来让 sessionId 优先,会让「离开会话但没触发 reset」的入口
   *  把上一个会话的 id 一直挂着,状态条于是显示别的会话的旁路条数。 */
  const btwSessionId = knownSessionId ?? sessionId;

  // 会话确定后拉旁路记录:问过的一定还在,不依赖本 tab 是否亲历过 btw-result,
  // 也不依赖本轮是否已经发过消息(重启后续接老会话时,init 要等第一条消息才来)
  useEffect(() => {
    if (!btwSessionId) {
      setBtw(BTW_EMPTY);
      return;
    }
    // 先按新会话归零:拉取是异步的,不清则这一拍状态条还挂着上一个会话的条数
    setBtw((b) => (b.sessionId === btwSessionId ? b : { ...BTW_EMPTY, sessionId: btwSessionId }));
    let alive = true;
    api
      .sideQuestions(btwSessionId)
      .then(({ records }) => {
        if (!alive) return;
        // REPLACE 语义:records 按会话挂载,换会话时上一个会话的记录必须整份换掉,
        // 只保留本地刚收到、库里还没有的同会话记录(btw-result 与拉库的竞态)。
        setBtw((b) => {
          const seen = new Set(records.map((r) => r.id));
          const local = b.sessionId === btwSessionId ? b.records.filter((r) => !seen.has(r.id)) : [];
          return { ...b, sessionId: btwSessionId, records: [...records, ...local] };
        });
      })
      .catch(() => {/* 记录拉不到不影响提问;面板空态兜底 */});
    return () => {
      alive = false;
    };
  }, [btwSessionId]);

  /** 入口登记「即将进入哪个会话」(续接 / 接回)。传 null = 不知道,由 init 兜底 */
  const noteSessionId = useCallback((id: string | null) => {
    setKnownSessionId(id);
  }, []);

  const askBtw = useCallback((question: string) => {
    wsRef.current?.send(JSON.stringify({ op: 'btw', question }));
  }, []);

  const cancelBtw = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ op: 'btw-cancel' }));
  }, []);

  /** 「存为经验」成功后回填 memory 路径(按钮转「已存为经验」) */
  const markBtwMemory = useCallback((id: number, memoryFile: string) => {
    setBtw((b) => ({ ...b, records: b.records.map((r) => (r.id === id ? { ...r, memoryFile } : r)) }));
  }, []);

  const clearBtwError = useCallback(() => {
    setBtw((b) => ({ ...b, error: null }));
  }, []);

  const pushNote = useCallback((text: string) => {
    setItems((prev) => [...prev, { t: 'note', text }]);
  }, []);

  /** 续接前装载历史对话(来自只读回放),插在当前消息之前 */
  /**
   * 历史前插过的条数。聊天行的 key 用「下标 − 前插数」(见 chatKey):历史是前插到列表头的,
   * 若直接用下标当 key,前插后所有已有行的 key 全变,React 会把它们整个卸掉重建,
   * 每条助手消息的 markdown 重新解析一遍。
   */
  const seedOffsetRef = useRef(0);
  const [seedOffset, setSeedOffset] = useState(0);
  const seedHistory = useCallback((history: ChatItem[]) => {
    seedOffsetRef.current += history.length;
    setSeedOffset(seedOffsetRef.current);
    setItems((prev) => [...history, ...prev]);
  }, []);

  const started = startedRef.current;
  return { items, status, chips, sessionId, model, costUsd, turn, started, attachedHistory, seedOffset, commands, commandUses, btw, noteSessionId, send, attach, decide, answer, interrupt, changeModel, reset, pushNote, seedHistory, askBtw, cancelBtw, markBtwMemory, clearBtwError };
}
