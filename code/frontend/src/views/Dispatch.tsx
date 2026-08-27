import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '@/api/client';
import { usePoll, isTypingTarget, useIsMobile } from '@/lib/hooks';
import { takeDispatchIntent, useDispatch, type ChatItem, type QuestionSpec } from '@/lib/dispatch';
import { canWrapup, cn, daySeparator, fmtCost, markSeen, projHue } from '@/lib/utils';
import { DropUp } from '@/components/DropUp';
import { ResumePalette } from '@/components/ResumePalette';
import { WdPalette } from '@/components/WdPalette';
import { CompactionCard, Md, MsgTime, ThinkingCard, ToolCard, toast } from '@/components/shared';
import { FindBar, useFindInPage } from '@/components/FindBar';
import { RunbookPanel } from '@/components/RunbookPanel';
import { useRunbook } from '@/lib/runbook';
import type { ClosedSession, ReplayEvent } from '@/api/types';

/**
 * StreamMd — 流式 markdown 渲染,块级记忆化。
 *
 * 核心:按 markdown 顶层块切分(双换行定界,跳过代码栅栏),每块走 <Md> 完整解析。
 * 已完成块用 React.memo 缓存(内容不变就不重渲染);
 * 只有最后一块(正在积累的未闭合块)每帧重渲染,但只解析一小段文本,
 * 不随全文增长而增加每帧解析成本。O(n²) → O(last_block)。
 */
const MdBlock = memo(function MdBlock({ text }: { text: string }) {
  return <Md>{text}</Md>;
});

/** 按 markdown 顶层块切分。尊重代码栅栏,栅栏内的空白行不触发分割。 */
function splitMdBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur = '';
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      cur += line + '\n';
    } else if (!inFence && line.trim() === '') {
      if (cur.trim()) {
        blocks.push(cur.trimEnd());
        cur = '';
      }
    } else {
      cur += line + '\n';
    }
  }
  const last = cur.trimEnd();
  if (last) blocks.push(last);
  return blocks;
}

function StreamMd({ text }: { text: string }) {
  const blocks = useMemo(() => splitMdBlocks(text), [text]);
  return (
    <>
      {blocks.map((block, i) => (
        <MdBlock key={i} text={block} />
      ))}
    </>
  );
}

/**
 * useTypewriter — 打字机平滑层(f9b2cad 解决的是"每帧解析成本",本层解决"到达粒度"):
 * 上游 delta 是成块到达的(SDK/API/网络缓冲一次推几十上百字符),即便渲染零成本,
 * 观感仍是"一坨坨蹦字"。这里把「到达文本」与「显示文本」解耦:每帧只放出少量字符,
 * 积压越多放得越快(按比例追赶),视觉延迟上界 ≈ CATCH_UP_FRAMES 帧,永不掉队。
 *
 * animate=false(历史装载/回放)直接全文显示不做动画;
 * 目标文本非纯追加(reset/attach 后按 index 复用的行拿到全新内容)时直接跳到全文。
 */
const MIN_CHARS_PER_FRAME = 2; // 放字下限 ~120 字/s(60fps):慢流时保持匀速打字感
const CATCH_UP_FRAMES = 84; // 追赶窗口:积压在 ~84 帧(1.4s)内放完;需大于上游 delta 块间隔才能填平"放完干等"的卡顿

function useTypewriter(target: string, animate: boolean): string {
  const [shown, setShown] = useState(() => (animate ? '' : target));
  const nRef = useRef(animate ? 0 : target.length); // 已放出的字符数
  const targetRef = useRef(target);
  const prevTargetRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  targetRef.current = target;

  useEffect(() => {
    if (!animate) {
      // 历史行:目标即显示,无动画(装载时已初始化,这里兜底 attach 复用行的场景)
      if (nRef.current !== target.length) {
        nRef.current = target.length;
        setShown(target);
      }
      return;
    }
    // 非纯追加 = 行被复用装了别的内容(index 作 key 的代价),直接对齐全文不动画
    if (!target.startsWith(prevTargetRef.current)) {
      nRef.current = target.length;
      setShown(target);
      prevTargetRef.current = target;
      return;
    }
    prevTargetRef.current = target;
    const step = () => {
      rafRef.current = null;
      const full = targetRef.current;
      if (nRef.current >= full.length) return; // 放完了,等下一段 delta 到达重启
      const backlog = full.length - nRef.current;
      const add = Math.max(MIN_CHARS_PER_FRAME, Math.ceil(backlog / CATCH_UP_FRAMES));
      nRef.current = Math.min(full.length, nRef.current + add);
      setShown(full.slice(0, nRef.current));
      if (nRef.current < full.length) rafRef.current = requestAnimationFrame(step);
    };
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, animate]);

  return shown;
}

/** 流式 assistant 消息的打字机包装:装载时就在流式中的行才做动画(回合结束后继续把
 *  余量放完,不因 streaming 翻 false 而跳变);历史消息直接全文。onGrow 在每次放字后
 *  通知父级跟滚(放字发生在 items 不变的帧里,父级按 items 触发的滚底看不见它)。 */
function TypewriterMd({ text, streaming, onGrow }: { text: string; streaming: boolean; onGrow?: () => void }) {
  const animRef = useRef(streaming);
  const shown = useTypewriter(text, animRef.current);
  useEffect(() => {
    onGrow?.();
  }, [shown, onGrow]);
  return <StreamMd text={shown} />;
}

/** 续接时装载的历史条数上限。⌘F 只能搜到已渲染的消息,查找条据此标注作用域。 */
const CHAT_SEED_LIMIT = 200;
/** 输入框高度下限,与 .composer textarea 的 min-height 同值(改一处必须改另一处) */
const TA_MIN_H = 56;

/** 粘贴图片:与后端 types.ts 的 INLINE_IMAGE_* 三个上限保持一致(改一处必须改另一处) */
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMG_MAX_BYTES = 5 * 1024 * 1024;
const IMG_MAX_COUNT = 8;

/** 待发送图片:base64 供上行,url(dataURL)供缩略图/灯箱渲染 */
interface PastedImage {
  id: string;
  media_type: string;
  data: string;
  url: string;
  bytes: number;
}

/** Blob → base64(去掉 dataURL 前缀);FileReader 而非 arrayBuffer+btoa,避免大图爆栈 */
function blobToPasted(blob: Blob): Promise<PastedImage> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('图片读取失败'));
    fr.onload = () => {
      const url = String(fr.result);
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        media_type: blob.type,
        data: url.slice(url.indexOf(',') + 1),
        url,
        bytes: blob.size,
      });
    };
    fr.readAsDataURL(blob);
  });
}

function fmtBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/** session jsonl 的 ISO 时间串 → ms epoch;老会话可能缺 ts,解析不出就当无时间 */
function parseTs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 只读回放事件 → 派发页消息(续接时装载历史,取尾部 CHAT_SEED_LIMIT 条) */
function replayToChat(events: ReplayEvent[]): ChatItem[] {
  return events.slice(-CHAT_SEED_LIMIT).map((ev, i): ChatItem => {
    if (ev.kind === 'user') return { t: 'user', text: ev.text, ts: parseTs(ev.ts) };
    if (ev.kind === 'assistant') return { t: 'assistant', text: ev.text, streaming: false, ts: parseTs(ev.ts) };
    if (ev.kind === 'tool')
      return { t: 'tool', id: `hist-${i}`, name: ev.name, input: ev.input, output: ev.output, isError: ev.isError };
    if (ev.kind === 'compact')
      return { t: 'compact', trigger: ev.trigger, preTokens: ev.preTokens, durationMs: ev.durationMs, summary: ev.summary };
    return { t: 'note', text: `⚠ 未知事件「${ev.type}」(原始记录见回放页)` };
  });
}

const MODELS = [
  '(默认)',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-5[1m]',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
];
const PERMS = ['default(逐项审批)', 'acceptEdits', 'bypassPermissions(免审批)', 'plan'];
const PERM_VALUE: Record<string, string> = {
  'default(逐项审批)': 'default',
  acceptEdits: 'acceptEdits',
  'bypassPermissions(免审批)': 'bypassPermissions',
  plan: 'plan',
};
/** 权限模式默认免审批(信任本机任务;需要逐项把关时手动切回) */
const DEFAULT_PERM = PERMS[2]!;
/** /model 简写 → 完整模型名 */
const MODEL_SHORT: Record<string, string> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-5',
  'opus-1m': 'claude-opus-5[1m]',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};
/** 完整模型名 → 简写(弹窗左列短名),未收录的完整名原样显示 */
const MODEL_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_SHORT).map(([short, full]) => [full, short]),
);
/** 模型默认沿用最近一次用过的,兜底 opus */
const LAST_MODEL_KEY = 'xuanji-last-model';
const initialModel = (): string => {
  const saved = localStorage.getItem(LAST_MODEL_KEY);
  return saved && MODELS.includes(saved) && saved !== MODELS[0] ? saved : 'claude-opus-5';
};

/** ⚑ 任务总结的固定触发语。wrapup skill 是语义触发(SDK 无原生 slash),措辞固定才有稳定命中率;
 *  明确要求「先识别边界再确认」是因为一个会话常做完多个任务,边界只能由模型判断后跟人对齐。 */
const WRAPUP_PROMPT =
  '执行 wrapup skill,把本会话刚完成的任务沉淀成一张收口卡;任务边界你先识别再向我确认,不要直接落盘。';

/** 思考深度档位(SDK effort);首项 = 自动,按模型取默认档(见 MODEL_DEFAULT_EFFORT) */
const EFFORTS = ['(自动)', 'low', 'medium', 'high', 'xhigh', 'max'];
/** 按模型的默认思考深度:opus-5 思考本身很深,日常派发用 low 已够且更省时省额度;
 *  未列出的模型不下发 effort,交给模型自身默认(通常 high) */
const MODEL_DEFAULT_EFFORT: Record<string, string> = {
  'claude-opus-5': 'low',
  'claude-opus-5[1m]': 'low',
};
const LAST_EFFORT_KEY = 'xuanji-last-effort';
const initialEffort = (): string => {
  const saved = localStorage.getItem(LAST_EFFORT_KEY);
  return saved && EFFORTS.includes(saved) ? saved : EFFORTS[0]!;
};

/** 会话标识(输入框上方,与用量条同行):名称按所属项目色荧光呈现,id 到手后补显。
 *  id 为 null 表示「已知名称/项目,SDK 会话尚未分配 id」(如刚发出首条消息);name 为 null 表示「未命名占位」。 */
interface SessCtx {
  id: string | null;
  name: string | null;
  project: string;
  cwd: string;
}

export function Dispatch({ active }: { active: boolean }) {
  const d = useDispatch();
  // 验收面板:清单存在才渲染(没有清单 = 退化为现状体验,面板不出现)
  const rb = useRunbook(d.sessionId);
  const isMobile = useIsMobile();
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const [cwd, setCwd] = useState<string>('');
  const [modelSel, setModelSel] = useState(initialModel);
  const [effortSel, setEffortSel] = useState(initialEffort);
  const [permSel, setPermSel] = useState(DEFAULT_PERM);
  const [bg, setBg] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<{ sessionId: string; name: string; cwd: string; project: string } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [resumePalette, setResumePalette] = useState(false);
  const [wdPalette, setWdPalette] = useState(false);
  const [wdQuery, setWdQuery] = useState('');
  const [modelPalette, setModelPalette] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  /** 待发送的粘贴图片(缩略图显示在输入框上方、composer 边框内);发送成功后清空 */
  const [attachments, setAttachments] = useState<PastedImage[]>([]);
  /** 灯箱查看的原图 dataURL,null 为关闭 */
  const [lightbox, setLightbox] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // 输入框高度跟随内容:下限 56px(= 原两行,短输入与改动前零差异),上限由 CSS max-height
  // 给(12 行或 40vh 取小),触顶后转 textarea 内部滚动并由 .at-max 亮出底部渐隐提示。
  // `.value =` 赋值不触发 input 事件,所以每个程序化写入点(预填/交接/建议词/历史回溯/清空)
  // 都要手动调一次,否则高度停在上一次的值。
  const growTa = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto'; // 先归零,否则 scrollHeight 只增不减
    const max = parseFloat(getComputedStyle(ta).maxHeight) || Infinity;
    const target = Math.max(TA_MIN_H, ta.scrollHeight);
    ta.style.height = `${Math.min(target, max)}px`;
    composerRef.current?.classList.toggle('at-max', target > max + 1);
  };
  // 输入框历史回溯:取材于当前会话自己的 d.items(t:'user'),天然按会话隔离——
  // 新会话/续接切会话时 d.items 会被清空或替换(reset/attach/seedHistory),不会跨会话残留。
  // historyIdxRef === null 表示「未在浏览,停在当前草稿」;否则是 hist 数组下标(0=最早)。
  const historyIdxRef = useRef<number | null>(null);
  const historyDraftRef = useRef<string>('');
  const chatRef = useRef<HTMLDivElement>(null);
  // 会话内查找(⌘F):只搜聊天区里已渲染的消息(历史 seed 上限见 replayToChat)
  const find = useFindInPage(chatRef);
  const pinnedRef = useRef(true); // 用户是否钉在消息区底部(详见下方自动滚底效应)
  const lastChatTopRef = useRef(0); // 上次观察到的消息区 scrollTop,用于判定滚动方向
  const lastChatHeightRef = useRef(0); // 上次观察到的 scrollHeight,用于区分「内容变矮」与「用户上翻」
  const scrollRafRef = useRef<number | null>(null); // rAF 合批 scrollTo,避免每帧重排
  const repin = () => {
    pinnedRef.current = true;
    lastChatTopRef.current = 0;
    lastChatHeightRef.current = 0;
  };
  /** 本次派发由哪条待办发起(待办页「开工」跳来):拿到 sessionId 后回填,横幅可解除关联 */
  const [fromTodo, setFromTodo] = useState<{ id: number; title: string } | null>(null);
  const [sessionCwd, setSessionCwd] = useState<string | null>(null);
  const [fromBoard, setFromBoard] = useState(false);
  const [sessCtx, setSessCtx] = useState<SessCtx | null>(null);

  const projects = projectsData?.projects ?? [];
  const cwdOptions = useMemo(() => projects.map((p) => p.path), [projects]);
  const curProject = projects.find((p) => p.path === (cwd || cwdOptions[0]));
  const effectiveCwd = cwd || cwdOptions[0] || '';

  /** 装载续接目标:清当前状态 → 记 resume 信息 → 预载历史对话(看板意图与 /resume 弹窗共用) */
  const applyResume = (info: { sessionId: string; name: string; cwd: string; project: string }) => {
    if (d.started || d.items.length > 0) d.reset();
    // 进入续接页装载历史 = 已浏览产出:立即标已读。
    // 派发页原有的 markSeen 效应依赖 d.sessionId(发出第一条消息才有值),
    // 「Space 进入只看不发」的路径会漏标,「待验收」切回看板不熄灭。
    markSeen(info.sessionId);
    repin();
    resetHistoryBrowse(); // 换会话:↑/↓ 回溯范围重新从这个(待续接)会话算起
    setSessionCwd(null);
    setResumeInfo(info);
    setSessCtx({ id: info.sessionId, name: info.name || null, project: info.project, cwd: info.cwd });
    setCwd(info.cwd);
    d.pushNote(`↻ 将续接会话 ${info.sessionId.slice(0, 8)}(${info.name}),发送第一条消息后恢复上下文。`);
    // 装载历史对话(原型既有设计,M1 移植时丢失):失败静默(未开始的会话没有转录)
    void api
      .replay(info.sessionId)
      .then((r) => d.seedHistory(replayToChat(r.events)))
      .catch(() => {});
  };

  /** /resume 弹窗选中:所有权预检 → 取消隐藏(卡片回看板) → 装载续接 */
  const pickClosed = async (s: ClosedSession) => {
    setResumePalette(false);
    try {
      const check = await api.canResume(s.sessionId);
      if (!check.ok) return toast(check.reason ?? '该会话当前不可续接');
      await api.unhideSession(s.sessionId);
      applyResume(s);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      taRef.current?.focus();
    }
  };

  /** 切换模型落点(/model 文本快路径与弹窗共用):已开始 → 只对当前会话 SDK setModel(不改新会话默认);
   *  未开始 → 设定新会话默认并记忆 */
  const applyModel = (resolved: string) => {
    if (d.started) {
      d.changeModel(resolved); // 仅当前会话
    } else {
      setModelSel(resolved);
      localStorage.setItem(LAST_MODEL_KEY, resolved);
      d.pushNote(`⇄ 模型已设为 ${resolved},本会话生效。`);
    }
  };

  /** 实际下发给 SDK 的思考深度:显式选过就用选的,否则回落到该模型的默认档(未列出的模型 = 不下发) */
  const resolvedEffort = effortSel === EFFORTS[0] ? MODEL_DEFAULT_EFFORT[modelSel] : effortSel;

  /** 设定思考深度(/effort 与下拉共用)。SDK 只支持建会话时定 effort、无运行时切换,
   *  所以已开始的会话不受影响,改动对下一个新会话生效 */
  const applyEffort = (v: string) => {
    setEffortSel(v);
    localStorage.setItem(LAST_EFFORT_KEY, v);
    const shown = v === EFFORTS[0] ? `自动(${MODEL_DEFAULT_EFFORT[modelSel] ?? '模型默认'})` : v;
    d.pushNote(
      d.started
        ? `◈ 思考深度已设为 ${shown};当前会话无法中途改,对下一个新会话生效。`
        : `◈ 思考深度已设为 ${shown},本会话生效。`,
    );
  };

  // 进入视图:接收跳转意图(看板续接/attach 接回/交接)并聚焦输入框;离开即清除来路,返回按钮随之隐藏。
  // 无意图进入(侧栏/数字键)= 全新派发:上一会话留在后端继续存活,可从会话页随时接回。
  const prevActiveRef = useRef(false);
  useEffect(() => {
    const entered = active && !prevActiveRef.current;
    prevActiveRef.current = active;
    if (!active) {
      setFromBoard(false);
      return;
    }
    const intent = takeDispatchIntent();
    // 清空条件必须含 items:只"看过"某会话(装载了历史但没发消息)时 started 为 false,残留照样要清
    if (!intent && entered && (d.started || d.items.length > 0)) {
      const wasLive = d.status.state === 'working' || d.status.state === 'awaiting-permission';
      d.reset();
      repin();
      resetHistoryBrowse();
      setResumeInfo(null);
      setSessionCwd(null);
      setSessCtx(null);
      if (wasLive) toast('上一个会话仍在后台运行,可在「会话」页接回');
    }
    if (intent?.attach) {
      // 接回 = 已浏览产出,立即标已读(同 applyResume)。派发页兜底的 markSeen 只在回合进行中生效,
      // 接回一个已收尾的「验收中」会话不会触发,不在此标则角标切回看板依旧亮着。
      markSeen(intent.attach.sessionId);
      // 换会话先清当前状态,避免输入串进旧会话
      if (d.started) d.reset();
      resetHistoryBrowse();
      setResumeInfo(null);
      setSessionCwd(intent.attach.cwd);
      setCwd(intent.attach.cwd);
      setFromBoard(true);
      // name/project 看板已随手带过来(见 DispatchIntent.attach 注释),id 待 attach 重放 init 事件后由下方 effect 补上
      setSessCtx({ id: null, name: intent.attach.name || null, project: intent.attach.project, cwd: intent.attach.cwd });
      repin();
      void d.attach(intent.attach.dispatchId);
    } else if (intent?.resume) {
      setFromBoard(true);
      applyResume(intent.resume);
    } else if (intent && (d.started || d.items.length > 0)) {
      // 待办「开工」等全新派发意图:残留的旧会话必须清干净,否则发送会串进旧会话,
      // 且旧会话已有的 sessionId 会立刻把这条待办错绑到不相干的会话上
      d.reset();
      repin();
      resetHistoryBrowse();
      setResumeInfo(null);
      setSessionCwd(null);
      setSessCtx(null);
    }
    // 「来自待办」横幅只属于带 todoId 的这一次进入:换任何别的方式进来都清掉,
    // 否则横幅跨会话残留,后续无关派发拿到 sessionId 还会把那条待办错绑过去
    if (entered && intent?.todoId === undefined) setFromTodo(null);
    // 待办「开工」:全新派发,带着待办的项目目录与内容进来(内容只预填,发不发由人决定)
    if (intent?.cwd) setCwd(intent.cwd);
    if (intent?.todoId !== undefined) setFromTodo({ id: intent.todoId, title: intent.prefill ?? '' });
    if (intent?.prefill && taRef.current) { taRef.current.value = intent.prefill; growTa(); }
    // 只在真正进入视图/带意图跳转时聚焦:useDispatch 每次渲染返回新对象,本效应实际随每次
    // 重渲染执行;无条件聚焦会在 WS 推送/轮询触发的重渲染中反复把焦点抢回派发框,
    // 顶掉 /wd 等弹窗内输入框的焦点(2026-07-16 真机确认)
    if (entered || intent) setTimeout(() => taRef.current?.focus(), 0);
  }, [active, d]);

  // 消息区自动滚底 —— 仅当用户钉在底部时跟随。
  // 修复:流式输出期间向上翻历史,每条新增量都把视口拽回底部,历史根本没法看。
  // 解钉/回钉用「滚动方向」判定而非只看距底距离:程序滚底后 scroll 事件异步派发,
  // 快速流式下事件到达时内容又长高了,按距离判会把程序滚底误判成"离开了底部"而自我解钉。
  // scrollTop 变小 = 用户向上翻(程序滚底只会变大,天然免疫)→ 解钉;滚回距底 <48px → 回钉,自愈无需按钮。
  // 会话切换类动作(发送/续接/接回/新会话/交接)一律重新钉住:那是用户主动回到「看最新」。
  // 内容变矮(思考卡结束后自动收起)会让浏览器把 scrollTop 夹回新的最大值,派发一个
  // scrollTop 变小的 scroll 事件 —— 那不是用户上翻,按方向判会误解钉,此后打字机继续输出
  // 却不再跟滚(用户看到画面卡住,手动往下划才见后文)。故 scrollHeight 变小的那次事件不解钉。
  const onChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    const prev = lastChatTopRef.current;
    const prevHeight = lastChatHeightRef.current;
    lastChatTopRef.current = el.scrollTop;
    lastChatHeightRef.current = el.scrollHeight;
    const shrank = el.scrollHeight < prevHeight;
    if (!shrank && el.scrollTop < prev - 1) pinnedRef.current = false;
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) pinnedRef.current = true;
  };
  // 跨天分隔线:与消息列表等长,daySeps[i] 非空表示第 i 条消息之前要插一条日期。
  // 工具卡/审批等无时间的条目不参与判定,故游标记的是「上一条有时间的消息」而非前一项。
  const daySeps = useMemo(() => {
    let prev: number | undefined;
    return d.items.map((it) => {
      const ts = it.t === 'user' || it.t === 'assistant' ? it.ts : undefined;
      if (ts == null) return null;
      const sep = daySeparator(prev, ts);
      prev = ts;
      return sep;
    });
  }, [d.items]);
  const followScroll = useCallback(() => {
    if (pinnedRef.current && scrollRafRef.current === null) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
      });
    }
  }, []);
  // items 变化(新消息/工具卡)与打字机放字(TypewriterMd onGrow)都要跟滚:
  // 打字机放字发生在 items 不变的帧里,只靠 items 触发会在回合尾部停止跟滚。
  useEffect(followScroll, [d.items, followScroll]);

  // 正在看着这个会话跑 = 已验收到当下:之后若有新产出会重新点亮「待验收」。
  // 只在回合进行中(working/awaiting-permission)标已读,回合收尾那一拍不标——
  // 收尾时 lastOutputAt 刚落在 result 上,继续标会把最后一笔产出也盖掉,卡片首次进
  // 「验收中」就没有角标(2026-08-11 反馈:是否盯着派发页跑完决定角标亮不亮)。
  // 收尾产出的已读交回显式动作:看板开回放 / 续接装载(applyResume)。
  useEffect(() => {
    if (!active || !d.sessionId) return;
    if (d.status.state !== 'working' && d.status.state !== 'awaiting-permission') return;
    markSeen(d.sessionId);
  }, [active, d.sessionId, d.status.state, d.costUsd]);

  // SDK 分配 sessionId(init 事件)后补上会话标识里悬空的 id——新会话首次发送、attach 重放 init 均走这里
  useEffect(() => {
    if (!d.sessionId) return;
    setSessCtx((prev) => (prev && prev.id === null ? { ...prev, id: d.sessionId } : prev));
  }, [d.sessionId]);

  // 接回存活会话时垫入更早的历史对话:attach 回放的内存事件只覆盖后端本进程生命周期,
  // 后端重启后续接过的会话再接回,重启前的上下文只存在于会话 jsonl 里(看板点击与刷新静默接回同走这里)。
  // 去重按时间戳切:before(= dispatch 创建时刻)之后的消息已在内存事件流里,只垫之前的;
  // 全新派发的会话没有更早历史(全部事件都晚于 before),过滤后为空,自动无操作。
  useEffect(() => {
    if (!d.attachedHistory) return;
    const { sessionId, before } = d.attachedHistory;
    void api
      .replay(sessionId)
      .then((r) => {
        const cut = r.events.findIndex((ev) => {
          const ts = parseTs((ev as { ts?: string }).ts);
          return ts !== undefined && ts >= before;
        });
        const past = cut === -1 ? r.events : r.events.slice(0, cut);
        if (past.length) d.seedHistory(replayToChat(past));
      })
      .catch(() => {}); // 会话记录被清理时垫不了历史,保持现状即可
  }, [d.attachedHistory]);

  // 待办发起的会话:SDK 分配 sessionId(= 真的发出去了)后把这条待办转「进行中」并挂上锚点。
  // 只在拿到 sessionId 时回填,所以「开工后又没发」不会污染待办状态;完成与否仍由人手动勾。
  useEffect(() => {
    if (!fromTodo || !d.sessionId) return;
    const todoId = fromTodo.id;
    setFromTodo(null);
    void api.updateTodo(todoId, { status: 'doing', sessionId: d.sessionId }).catch(() => {});
  }, [fromTodo, d.sessionId]);

  // 兜底:刷新页面后 useDispatch 内部静默 attach 回存活会话(不经过看板意图),
  // 本组件没有 name/project 可用,按 sessionId 查一次会话看板补全。
  useEffect(() => {
    if (!d.sessionId || sessCtx) return;
    let cancelled = false;
    void api
      .sessions()
      .then((board) => {
        if (cancelled) return;
        const match = Object.values(board.columns).flat().find((s) => s.sessionId === d.sessionId);
        if (match) setSessCtx({ id: match.sessionId, name: match.name || null, project: match.project, cwd: match.cwd });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [d.sessionId, sessCtx]);

  // 看板 ↔ 派发往返闭环(原型获批设计):从看板进入的会话 ← / Esc 返回看板。
  // ←:焦点在 composer 且输入为空时同样生效(有内容时保持移光标本职);
  // Esc:下拉打开时让位给 DropUp 关闭,焦点在输入控件时让位给 blur,兜底才返回。
  useEffect(() => {
    if (!active || !fromBoard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') {
        const ta = taRef.current;
        if (isTypingTarget(e.target) && !(ta && e.target === ta && !ta.value)) return;
        if (e.isComposing) return;
        e.preventDefault();
        location.hash = 'sessions';
      } else if (e.key === 'Escape') {
        if (document.querySelector('.dd.open') || isTypingTarget(e.target)) return;
        location.hash = 'sessions';
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, fromBoard]);

  // 灯箱 Esc 关闭:捕获阶段拦截,免得同一下 Esc 又被 composer/看板返回逻辑吃掉
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setLightbox(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [lightbox]);

  /** ⚑ 任务总结的实际动作。用 ref 持有最新闭包,让下方快捷键监听只依赖 active、不必每次渲染重挂。 */
  const wrapupRef = useRef<() => void>(() => {});
  wrapupRef.current = () => {
    if (!canWrapup(d.started, !!resumeInfo)) {
      toast('这里还没有可收口的上下文,先派发或续接一个会话');
      return;
    }
    void submit(WRAPUP_PROMPT);
  };

  // ⌘M 切换模型 / ⌘D 切换工作目录 / ⌘⏎ 任务总结:仅派发页生效,等同于在输入框敲 /model、/wd、/wrapup 回车
  // (见 submit() 同名分支),直接执行而不必真的经过文本解析。拦截浏览器默认行为(⌘M 最小化窗口、⌘D 加书签)。
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        taRef.current?.blur();
        setModelQuery('');
        setModelPalette(true);
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        taRef.current?.blur();
        setWdQuery('');
        setWdPalette(true);
      } else if (e.key === 'Enter' && !e.isComposing) {
        // isComposing:中文输入法候选窗里的回车不劫持(否则选词就变成发总结)
        e.preventDefault();
        wrapupRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);

  /** 当前会话自己发过的 prompt(按发送顺序,最早在前);d.items 本就随会话切换清空/重建,天然不跨会话 */
  const promptHistory = (): string[] => d.items.filter((i): i is Extract<ChatItem, { t: 'user' }> => i.t === 'user').map((i) => i.text);

  /** 回到「未在浏览」:发消息(该 prompt 已进 d.items,自然成为历史最新一条)/ 换会话时调用 */
  const resetHistoryBrowse = () => {
    historyIdxRef.current = null;
    historyDraftRef.current = '';
  };

  /** ↑(dir=-1)取更早一条,↓(dir=1)取更新一条;越过最新一条时恢复浏览前的草稿。
   *  历史条目本身可能含换行(真实任务描述常见),所以「是否劫持方向键」只在草稿态按内容判——
   *  一旦已经在浏览历史(historyIdxRef !== null),后续 ↑/↓ 无条件继续翻,不会被途中某条多行历史卡住。 */
  const recallPromptHistory = (dir: -1 | 1) => {
    const ta = taRef.current;
    if (!ta) return;
    const hist = promptHistory();
    if (hist.length === 0) return;
    if (dir === -1) {
      if (historyIdxRef.current === null) {
        historyDraftRef.current = ta.value;
        historyIdxRef.current = hist.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current -= 1;
      }
      // 已在最早一条:原地不动
    } else {
      if (historyIdxRef.current === null) return; // 本就在草稿态,没有更"新"的可去
      if (historyIdxRef.current < hist.length - 1) {
        historyIdxRef.current += 1;
      } else {
        historyIdxRef.current = null; // 越过最新一条,回到浏览前的草稿
      }
    }
    ta.value = historyIdxRef.current === null ? historyDraftRef.current : hist[historyIdxRef.current]!;
    growTa();
    const pos = ta.value.length;
    ta.setSelectionRange(pos, pos);
  };

  /** override:不经输入框直接发一段文本(⚑ 任务总结按钮与 ⌘⏎ 走这条路,与手打 /wrapup 完全等价) */
  const submit = async (override?: string) => {
    const ta = taRef.current;
    const text = override ?? ta?.value.trim() ?? '';
    // 程序化调用(/wrapup 等)不带图;用户手动发送时,只有图片没有文字也算一条有效消息
    const images = override ? [] : attachments;
    if ((!text && !images.length) || !effectiveCwd) return;
    if (!override) {
      ta!.value = '';
      growTa();
      resetHistoryBrowse();
    }
    // /resume 恢复已关闭会话:弹窗列出当前项目的隐藏会话,选中即 unhide + 续接
    if (/^\/resume\b/.test(text)) {
      // blur 派发框:弹窗期间不让输入框吃字符,也避免输入框焦点环与弹窗玉色选中环同屏双环
      ta?.blur();
      setResumePalette(true);
      return;
    }
    // /clear 清空上下文:SDK 环境下原生 /clear 会被当普通 prompt 发给模型(白烧一轮 token 且上下文照旧),
    // 故拦截为璇玑等价语义 —— 丢弃当前会话上下文另起一轮,工作目录/模型/权限档等派发设置保持不变(等同 ⌘N)。
    // 旧会话不 kill:仍在跑的留在后台,可在「会话」页接回。
    if (/^\/clear\b/.test(text)) {
      const wasLive = d.status.state === 'working' || d.status.state === 'awaiting-permission';
      newSession();
      toast(wasLive ? '已清空上下文;上一个会话仍在后台运行,可在「会话」页接回' : '已清空上下文,开始新会话');
      return;
    }
    // /wrapup 任务总结:把刚完成的任务沉淀成一张卡落到 ~/.claude/worklog/(见「总结」视图)。
    // skill 靠语义触发、SDK 没有原生 slash,所以拦下来换成一句固定触发语发出去——固定措辞保证命中率,
    // 也避免每次靠临场措辞碰运气。璇玑自己不写盘,出卡动作全在会话内由 skill 完成(架构铁律 2)。
    if (/^\/wrapup\b/.test(text)) {
      if (!canWrapup(d.started, !!resumeInfo)) return toast('这里还没有可收口的上下文,先派发或续接一个会话');
      void submit(WRAPUP_PROMPT);
      return;
    }
    // /wd 切换工作目录:弹窗模糊搜索历史项目目录,↑↓ 选中即改新会话 cwd。
    // 支持 /wd <关键词> 直接带初始搜索词(如 /wd skill)。
    if (/^\/wd\b/.test(text)) {
      setWdQuery(text.replace(/^\/wd\b/, '').trim());
      // WKWebView 下派发框不主动释放焦点会顶掉弹窗搜索框的抢焦(真机确认 2026-07-16),
      // 先显式 blur 再开弹窗,配合 WdPalette 内的轮询聚焦兜底
      ta?.blur();
      setWdPalette(true);
      return;
    }
    // /rename 是终端专属命令,SDK 环境不可用 → 拦截为璇玑自己的改名(display-name 存自有 SQLite)
    if (/^\/rename\b/.test(text)) {
      const newName = text.replace(/^\/rename\b/, '').trim();
      if (!newName) return toast('用法:/rename 新的会话名');
      if (!d.sessionId) return toast('会话尚未开始,发送第一条消息后再改名');
      try {
        await api.renameSession(d.sessionId, newName);
        setSessCtx((prev) => (prev ? { ...prev, name: newName } : prev));
        d.pushNote(`✎ 会话已重命名为「${newName}」(存璇玑本地,看板即时生效;不写 ~/.claude)`);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // /model 切换模型:精确命中简写/完整名 → 直接切(保留快路径,如 /model fable);
    // 无参数或没命中 → 弹窗模糊搜索(与 /wd 同款,/model fab 会以 fab 为初始搜索词进弹窗)
    if (/^\/model\b/.test(text)) {
      const arg = text.replace(/^\/model\b/, '').trim().toLowerCase();
      const resolved = MODELS.find((m) => m.toLowerCase() === arg) ?? MODEL_SHORT[arg];
      if (resolved && resolved !== MODELS[0]) {
        applyModel(resolved);
        return;
      }
      setModelQuery(arg);
      // WKWebView 焦点竞争:先显式 blur 派发框再开弹窗(同 /wd,详见 WdPalette 注释)
      ta?.blur();
      setModelPalette(true);
      return;
    }
    // /effort 设定思考深度:auto 回到按模型取默认档;无参数只回报当前值(档位就 5 个,不值得再开弹窗)
    if (/^\/effort\b/.test(text)) {
      const arg = text.replace(/^\/effort\b/, '').trim().toLowerCase();
      if (!arg) {
        const shown = effortSel === EFFORTS[0] ? `自动 → ${resolvedEffort ?? '模型默认'}` : effortSel;
        d.pushNote(`◈ 当前思考深度:${shown}。用法:/effort ${EFFORTS.slice(1).join('|')}|auto`);
        return;
      }
      if (arg === 'auto') {
        applyEffort(EFFORTS[0]!);
        return;
      }
      if (!EFFORTS.includes(arg)) return toast(`未知档位「${arg}」,可选:${EFFORTS.slice(1).join(' / ')} / auto`);
      applyEffort(arg);
      return;
    }
    if (modelSel !== MODELS[0]) localStorage.setItem(LAST_MODEL_KEY, modelSel);
    // 续接发送沿用 applyResume 已定好的标识;全新会话在此刻就知道名称(取自首条消息)与项目,不必等 SDK 分配 id。
    // 仅在 sessCtx 尚未建立时(真正的第一条消息)才用 prompt 占位命名 —— 否则 attach/续接已带
    // 正确名称进来后,发第二条及以后的消息会用当次 prompt 把已有会话名覆盖掉(bug: 输入框上方短暂显示成刚发的话)。
    // 只发图不发字时没有可用作会话名的文本,退回一句占位(SDK 分配 id 后看板仍可改名)
    const autoName = text.slice(0, 40) || `图片消息 ×${images.length}`;
    if (!resumeInfo && !sessCtx) {
      setSessCtx({ id: null, name: autoName, project: curProject?.name ?? effectiveCwd, cwd: effectiveCwd });
    }
    repin(); // 发消息 = 主动回到「看最新」
    try {
      if (bg) {
        await d.send(text, { cwd: effectiveCwd, permissionMode: 'default', bg: true });
        toast('已派发后台任务');
        return;
      }
      if (!d.started) setSessionCwd(effectiveCwd);
      await d.send(text, {
        cwd: effectiveCwd,
        permissionMode: PERM_VALUE[permSel]!,
        model: modelSel === MODELS[0] ? undefined : modelSel,
        effort: resolvedEffort,
        resume: resumeInfo?.sessionId,
        name: resumeInfo?.name ?? autoName,
        images: images.map((im) => ({ media_type: im.media_type, data: im.data })),
      });
      // 送达才清空:发送抛错时图片留在输入框,不用重新截一次
      if (images.length) setAttachments([]);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const newSession = () => {
    d.reset();
    repin();
    resetHistoryBrowse();
    setResumeInfo(null);
    setSessionCwd(null);
    setSessCtx(null);
    setFromBoard(false);
    taRef.current?.focus();
  };

  // ⌘N 全局新建会话:App 层导航到派发页并广播该事件(已在派发页时 hash 不变,靠事件驱动)
  const newSessionRef = useRef(newSession);
  newSessionRef.current = newSession;
  useEffect(() => {
    const onNew = () => setTimeout(() => newSessionRef.current(), 50);
    window.addEventListener('xuanji:new-session', onNew);
    return () => window.removeEventListener('xuanji:new-session', onNew);
  }, []);

  const doHandoff = async () => {
    if (!d.sessionId || handoffBusy) return;
    setHandoffBusy(true);
    toast('正在生成交接摘要…');
    try {
      const { summary, from } = await api.handoff(d.sessionId);
      const target = effectiveCwd;
      d.reset();
      repin();
      resetHistoryBrowse();
      setResumeInfo(null);
      setSessionCwd(target);
      // 交接落地的新会话尚未发消息,还没有名称;项目已知(交接目标),先占位显示未命名
      setSessCtx({ id: null, name: null, project: curProject?.name ?? target, cwd: target });
      d.pushNote(`⇢ 已从「${from}」携带交接摘要,新会话将运行在 ${target}。摘要已注入,直接描述要继续的工作。`);
      if (taRef.current) {
        taRef.current.value = `以下是上一会话的交接摘要:\n${summary}\n\n请基于以上上下文继续:`;
        growTa();
        taRef.current.focus();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setHandoffBusy(false);
    }
  };

  const statusText = (() => {
    switch (d.status.state) {
      case 'none':
        return { text: '空闲 · 新会话待派发', cls: '' };
      case 'working':
        return { text: d.items.some((i) => i.t === 'assistant' && i.streaming) ? '回复生成中…' : '思考中…', cls: 'think' };
      case 'awaiting-permission':
        return d.status.detail === '回答 Claude 的提问'
          ? { text: 'Claude 有问题等你回答', cls: 'wait' }
          : { text: `等待你审批:${d.status.detail ?? ''}`, cls: 'wait' };
      case 'idle':
        return { text: `空闲 · 回合结束${d.costUsd ? ` · 本会话 ${fmtCost(d.costUsd)}` : ''}`, cls: '' };
      case 'ended':
        return { text: '会话已结束', cls: '' };
    }
  })();

  const showCwdNote = d.started && sessionCwd && effectiveCwd !== sessionCwd;
  const nowTick = useMinuteTick();

  return (
    <>
      <div className="view-head">
        <h1>派发</h1>
        {fromBoard && (
          <button className="btn btn-sm" title="快捷键 ← 或 Esc" onClick={() => (location.hash = 'sessions')}>
            ‹ 会话看板
          </button>
        )}
        <span className="spacer" />
        <button className="btn" title="⌘N" onClick={newSession}>新会话</button>
      </div>
      <div className="dispatch">
        <div className="chat" ref={chatRef} onScroll={onChatScroll}>
          <FindBar
            scopeRef={chatRef}
            state={find}
            placeholder="在本次对话中查找"
            note={d.items.length >= CHAT_SEED_LIMIT ? `仅搜索已加载的 ${CHAT_SEED_LIMIT} 条` : undefined}
          />
          {/* 移动端:会话标识挪进消息区顶部随内容滚动,让出状态条的横向空间给用量条(见下方 .chat-status)——
              桌面维持原样(标识常驻状态条最左端),两端各显示一份,靠 CSS 二选一(2026-07-16 真机反馈修复:
              状态条三段挤在一行导致 Context/Usage/Weekly 用量条被推出可视区、只能横滑才看得见)。 */}
          {isMobile && sessCtx && (
            <div className="chat-sessctx-mobile">
              <SessCtxBadge ctx={sessCtx} />
            </div>
          )}
          {d.items.length === 0 && (
            <div className="chat-empty">
              <h2>派发一个新任务</h2>
              <p>
                会话经 Agent SDK 执行,加载与终端一致的 skills / MCP / CLAUDE.md;工具调用逐项经你审批。
                转后台的任务建议写全任务描述并放宽权限模式,避免无人值守时卡在审批上。
              </p>
              <div className="sugg">
                <button onClick={() => { taRef.current!.value = '扫描近 7 天的高风险 IP,输出报告'; growTa(); taRef.current?.focus(); }}>扫描高风险 IP</button>
                <button onClick={() => { taRef.current!.value = '用 baize 对昨日收入异动做归因,结果发飞书卡片'; growTa(); taRef.current?.focus(); }}>收入异动归因</button>
                <button onClick={() => { taRef.current!.value = '把本周会话里踩过的坑提炼成 memory 草稿'; growTa(); taRef.current?.focus(); }}>提炼本周经验</button>
              </div>
            </div>
          )}
          {d.items.map((item, i) => (
            <Fragment key={i}>
              {daySeps[i] && <div className="day-sep">{daySeps[i]}</div>}
              <ChatRow item={item} onDecide={d.decide} onAnswer={d.answer} onGrow={followScroll} onZoom={setLightbox} />
            </Fragment>
          ))}
        </div>

        {rb.runbook && (
          <RunbookPanel
            runbook={rb.runbook}
            runs={rb.runs}
            logs={rb.logs}
            errors={rb.errors}
            onRun={rb.run}
            onStop={rb.stop}
            onRequest={rb.sendRequest}
          />
        )}

        <div className="chat-status">
          {!isMobile && sessCtx && <SessCtxBadge ctx={sessCtx} />}
          <span className="u-chips">
            <Chip label="Context" pct={d.chips.contextPct} now={nowTick} />
            <Chip
              label="Usage"
              pct={d.chips.fiveHourPct}
              resetsAt={d.chips.fiveHourResetsAt}
              windowMs={FIVE_HOUR_MS}
              now={nowTick}
            />
            <WeeklyChip
              pct={d.chips.sevenDayPct}
              modelPct={d.chips.modelWeeklyPct}
              modelName={d.chips.modelWeeklyName}
              resetsAt={d.chips.sevenDayResetsAt}
              now={nowTick}
            />
          </span>
          <span className={cn('cs-state', statusText.cls)}>
            <span className="cs-dot" />
            {statusText.text}
          </span>
        </div>

        {/* 待办来源横幅:说明本次派发由哪条待办发起(发送后它转「进行中」);✕ 解除关联 = 当普通新会话发 */}
        {fromTodo && (
          <div className="from-todo">
            ✦ 来自待办:「{fromTodo.title}」 · 发送后此待办转为进行中
            <button className="x" onClick={() => setFromTodo(null)} title="解除关联" aria-label="解除关联">✕</button>
          </div>
        )}

        <div className={cn('composer', attachments.length && 'has-attach')} ref={composerRef}>
          {/* 待发送图片条:在 textarea 上方、composer 边框之内 —— 图片与文字同属一条待发消息 */}
          {attachments.length > 0 && (
            <div className="attach-strip">
              {attachments.map((im) => (
                <div
                  key={im.id}
                  className="attach-chip"
                  title={`图片 · ${fmtBytes(im.bytes)} · 点击查看原图`}
                  onClick={() => setLightbox(im.url)}
                >
                  <img src={im.url} alt="待发送图片" />
                  <button
                    className="rm"
                    aria-label="移除图片"
                    title="移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAttachments((prev) => prev.filter((x) => x.id !== im.id));
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={2}
            placeholder="描述要派发的任务…"
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (!files.length) return; // 纯文本粘贴走默认行为
              e.preventDefault();
              if (bg) return toast('后台任务(--bg)走 CLI 通道,不支持粘贴图片;关掉「转后台」再试');
              void (async () => {
                // 名额按「本次渲染已有的张数」预扣:异步读图期间不能靠 setState 回读当前长度
                let slots = IMG_MAX_COUNT - attachments.length;
                for (const f of files) {
                  if (slots <= 0) {
                    toast(`一条消息最多带 ${IMG_MAX_COUNT} 张图片`);
                    break;
                  }
                  if (!IMG_TYPES.includes(f.type)) {
                    toast(`不支持的图片格式:${f.type || '未知'}`);
                    continue;
                  }
                  if (f.size > IMG_MAX_BYTES) {
                    toast(`「${fmtBytes(f.size)}」超过单张 ${IMG_MAX_BYTES / 1024 / 1024}MB 上限`);
                    continue;
                  }
                  slots -= 1;
                  try {
                    const img = await blobToPasted(f);
                    setAttachments((prev) => (prev.length >= IMG_MAX_COUNT ? prev : [...prev, img]));
                  } catch {
                    toast('图片读取失败');
                  }
                }
              })();
            }}
            onKeyDown={(e) => {
              // 排除 metaKey:⌘⏎ 归 ⚑ 任务总结(见下方 document 级监听)。
              // 此前这里没排除,⌘⏎ 也走发送——不改的话一次按键会既发草稿又触发总结。
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
                e.preventDefault();
                void submit();
              }
              if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
              // ↑/↓ 回溯历史 prompt(类 shell history)。草稿态(尚未开始浏览)只在草稿不含换行时
              // 接管方向键,避免打断 Shift+Enter 多行草稿的行间移动;一旦已经在浏览历史(某条历史
              // 本身可能带换行),后续 ↑/↓ 无条件继续翻,不会被中途某条多行历史卡住(2026-07-15 修复)。
              if (
                (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                !e.nativeEvent.isComposing &&
                (historyIdxRef.current !== null || !(e.target as HTMLTextAreaElement).value.includes('\n'))
              ) {
                e.preventDefault();
                recallPromptHistory(e.key === 'ArrowUp' ? -1 : 1);
              }
              // 空输入 ← 返回看板:与 document 级监听冗余——WKWebView(Pake)上
              // 依赖冒泡+target 判定的链路不可靠,元素级处理内核无关
              if (
                e.key === 'ArrowLeft' &&
                fromBoard &&
                !(e.target as HTMLTextAreaElement).value &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                location.hash = 'sessions';
              }
            }}
            onInput={() => {
              // 用户手动编辑(非程序回溯赋值,.value= 不触发 input 事件)→ 退出浏览态,回到「当前草稿」指针
              historyIdxRef.current = null;
              growTa();
            }}
          />
          {/* 触顶提示:内容超过高度上限、转为输入框内部滚动时才现出的一线渐隐,告诉人"上面还有" */}
          <div className="grow-fade" aria-hidden="true" />
          <div className="c-bar">
            {/* ⚑ 任务总结:把刚做完的任务沉淀成一张卡(等同输入 /wrapup)。玉色 tint 与灰字 hint 拉开层级,
                但不加脉冲/发光——wrapup 禁止自动触发,入口常驻即可,「高亮」靠稀缺的玉色本身。 */}
            <button
              className="wrapup-btn"
              onClick={() => wrapupRef.current()}
              disabled={!canWrapup(d.started, !!resumeInfo)}
              title={
                canWrapup(d.started, !!resumeInfo)
                  ? '⌘⏎ · 把本会话刚完成的任务沉淀成一张收口卡,落到 ~/.claude/worklog/(等同输入 /wrapup);边界由 Claude 识别后与你确认'
                  : '这里还没有可收口的上下文,先派发或续接一个会话'
              }
            >
              <span className="flag">⚑</span>任务总结<span className="kbd">⌘⏎</span>
            </button>
            <span className="hint">Enter 发送 · Shift+Enter 换行 · ↑↓ 历史</span>
            {d.status.state === 'working' && (
              <button className="btn btn-sm" onClick={d.interrupt}>打断</button>
            )}
            <label className="bg-opt" title="转后台(--bg):交给 daemon 托管,回会话看板跟踪">
              <span
                className={cn('switch', bg && 'on')}
                role="switch"
                aria-checked={bg}
                aria-label="转后台(--bg)"
                tabIndex={0}
                onClick={() => setBg(!bg)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBg(!bg); } }}
              />
              {/* 移动端只留开关本体(title/aria-label 承载说明文字),给发送按钮腾出宽度——
                  桌面文字常驻(2026-07-16 真机反馈修复:发送按钮被挤到显示不全) */}
              <span className="bg-opt-label">转后台(--bg)</span>
            </label>
            <button className="btn btn-primary send-btn" onClick={() => void submit()} aria-label="发送">
              <span className="send-btn-label">发送</span>
              <svg className="send-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="term-line">
          <DropUp
            id="cwd-dd"
            value={effectiveCwd}
            options={cwdOptions}
            onChange={setCwd}
            labelOf={(p) => projects.find((x) => x.path === p)?.name ?? p.split('/').filter(Boolean).pop() ?? p}
            title={`工作目录:决定下一个派发会话的 cwd 与加载的项目级 CLAUDE.md${effectiveCwd ? `\n${effectiveCwd}` : ''}`}
          />
          <span className="branch mono" title="git 状态:! 已修改 · ? 未跟踪 · ↑ 领先远端未推送">
            {curProject?.git ? (
              <>
                ⎇ {curProject.git.branch}
                {curProject.git.modified > 0 && <span className="gs-m"> !{curProject.git.modified}</span>}
                {curProject.git.untracked > 0 && <span className="gs-u"> ?{curProject.git.untracked}</span>}
                {(curProject.git.ahead ?? 0) > 0 && <span className="gs-a"> ↑{curProject.git.ahead}</span>}
              </>
            ) : (
              '⎇ —'
            )}
          </span>
          <span className="spacer" />
          <DropUp
            id="model-dd"
            value={d.started ? (MODELS.find((m) => m === d.model) ?? d.model ?? modelSel) : modelSel}
            options={MODELS}
            onChange={(v) => {
              // 有活跃会话 → 只切当前会话(SDK setModel,不改新会话默认);无会话 → 设新会话默认并记忆
              if (d.started) {
                if (v !== MODELS[0]) d.changeModel(v);
              } else {
                setModelSel(v);
                if (v !== MODELS[0]) localStorage.setItem(LAST_MODEL_KEY, v);
              }
            }}
            title={d.started ? '当前会话模型(切换只对本会话生效)' : '新会话默认模型(记忆最近一次)'}
          />
          <DropUp
            className="dim"
            id="effort-dd"
            value={effortSel}
            options={EFFORTS}
            // 首项标注解析结果(如「思考 自动(low)」),否则它与显式 low 在列表里同名、无法区分
            labelOf={(v) =>
              v === EFFORTS[0] ? `思考 自动(${MODEL_DEFAULT_EFFORT[modelSel] ?? '模型默认'})` : `思考 ${v}`
            }
            onChange={applyEffort}
            title={`思考深度(SDK effort),对下一个新会话生效——SDK 不支持会话中途切换。\n自动 = 按当前模型的默认档(opus-5 → low),其余模型不下发、用模型自身默认(通常 high)`}
          />
          <DropUp
            className="dim"
            value={permSel}
            options={PERMS}
            onChange={setPermSel}
            title="权限模式,对下一个新会话生效:default 逐项审批 · acceptEdits 自动放行文件编辑 · bypassPermissions 全部免审批(信任任务时用) · plan 只规划不执行"
          />
          <span className="tag">settingSources: user</span>
        </div>
        {resumePalette && (
          <ResumePalette
            cwd={effectiveCwd}
            onPick={(s) => void pickClosed(s)}
            onClose={() => {
              setResumePalette(false);
              taRef.current?.focus();
            }}
          />
        )}
        {wdPalette && (
          <WdPalette
            value={effectiveCwd}
            options={cwdOptions}
            initialQuery={wdQuery}
            labelOf={(p) => projects.find((x) => x.path === p)?.name ?? p.split('/').filter(Boolean).pop() ?? p}
            onPick={(p) => {
              setCwd(p);
              setWdPalette(false);
              taRef.current?.focus();
            }}
            onClose={() => {
              setWdPalette(false);
              taRef.current?.focus();
            }}
          />
        )}
        {modelPalette && (
          <WdPalette
            title="切换模型"
            placeholder="模糊搜索模型…(如 fable)"
            emptyNoun="模型"
            value={d.started ? (d.model ?? modelSel) : modelSel}
            options={MODELS.slice(1)}
            labelOf={(m) => MODEL_ALIAS[m] ?? m}
            initialQuery={modelQuery}
            onPick={(m) => {
              applyModel(m);
              setModelPalette(false);
              taRef.current?.focus();
            }}
            onClose={() => {
              setModelPalette(false);
              taRef.current?.focus();
            }}
          />
        )}
        {/* 图片灯箱:点缩略图看原图,点任意处或 Esc 关闭 */}
        {lightbox && (
          <div
            className="lightbox open"
            role="dialog"
            aria-label="查看原图"
            onClick={() => setLightbox(null)}
          >
            <img src={lightbox} alt="原图" />
          </div>
        )}
        {showCwdNote && (
          <div className="cwd-note">
            <span className="dot" />
            <span>当前会话仍绑定 <span className="mono">{sessionCwd}</span> · 新目录对下一个会话生效</span>
            <button className="btn btn-sm" disabled={handoffBusy} onClick={() => void doHandoff()}>
              {handoffBusy ? '生成摘要中…' : `携带摘要在 ${effectiveCwd.split('/').pop()} 开新会话`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** 两个配额窗口的时长(与 Claude 订阅口径一致):用于把 resetsAt 反推成「窗口已过去多少」 */
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/** 用量三档取色:<50% 玉(健康)/ 50–75% 琥珀(注意)/ ≥75% 红(告警) */
function usageColor(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  if (pct >= 75) return 'var(--red)';
  if (pct >= 50) return 'var(--amber)';
  return 'var(--jade-dim)';
}

/** 剩余重置时长:resetsAt(ms) → 「Xh Ym 后重置」/「Ym 后重置」 */
function untilReset(resetsAt: number | null | undefined, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt - now;
  if (ms <= 0) return '即将重置';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h > 0 ? `${h}h ` : ''}${m}m 后重置`;
}

/** 紧凑倒计时(常驻状态条,不能占太宽):「2h41m」/「3d4h」/「41m」 */
function untilResetShort(resetsAt: number | null | undefined, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt - now;
  if (ms <= 0) return '即将重置';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/** 分钟级心跳:倒计时与时间刻度靠它自走,不再依赖流式事件顺带触发的重渲染 */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** 会话标识:名称按项目色荧光呈现,id 未到手前只显名称+项目;悬停给出完整信息(未命名时提示原因)。 */
function SessCtxBadge({ ctx }: { ctx: SessCtx }) {
  const named = !!ctx.name;
  const hue = projHue(ctx.project);
  const title = `${named ? ctx.name : '会话名称加载中…'} · 项目 ${ctx.project}(${ctx.cwd})`;
  return (
    <div className="sess-ctx" title={title}>
      <span className={cn('sc-title', named ? 'sc-named' : 'sc-unnamed')} style={{ '--ph': hue } as CSSProperties}>
        {named ? ctx.name : '未命名会话'}
      </span>
      {ctx.id && <span className="sc-id">{ctx.id.slice(0, 8)}</span>}
    </div>
  );
}

/**
 * 用量芯片:轨道本身即「配额窗口」,填充是已用比例,轨上那道亮刻度是当前时刻在窗口中的位置——
 * 填充越过刻度即「烧超了」,不读数字也一眼可见。紧凑倒计时常驻在百分比后作为兜底
 * (此前只写在 title 里,必须悬停才看得见,移动端根本摸不到)。
 * windowMs 缺省(Context 无重置窗口)时不画刻度、不显倒计时。
 */
function Chip({
  label,
  pct,
  resetsAt,
  windowMs,
  now,
}: {
  label: string;
  pct: number | null;
  resetsAt?: number | null;
  windowMs?: number;
  now: number;
}) {
  const color = usageColor(pct);
  const alert = pct !== null && pct >= 50;
  const reset = untilReset(resetsAt, now);
  // 窗口时间进度:剩余时长反推已流逝比例;数据异常(reset 早于/远超窗口)时夹到 0–100 不画到轨外
  const timePct =
    resetsAt && windowMs ? Math.min(100, Math.max(0, ((windowMs - (resetsAt - now)) / windowMs) * 100)) : null;
  const overspent = pct !== null && timePct !== null && pct > timePct + 5;
  const title =
    pct === null
      ? '会话产生用量数据后显示'
      : [
          `${label} ${pct}%`,
          reset,
          timePct === null ? null : `窗口已过去 ${Math.round(timePct)}%${overspent ? ' · 用量领先于时间' : ''}`,
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <span className="u-chip" title={title}>
      <span className="u-lab">{label}</span>
      <span className="u-bar">
        <i style={{ width: `${pct ?? 0}%`, background: color }} />
        {timePct !== null && <span className="u-tick" style={{ left: `${timePct}%` }} aria-hidden="true" />}
      </span>
      <b style={alert ? { color } : undefined}>{pct === null ? '—' : `${pct}%`}</b>
      {reset && <em className="u-reset">{untilResetShort(resetsAt, now)}</em>}
    </span>
  );
}

/**
 * Weekly 合并双轨芯片(原型 prototype-fable-quota.html 方案 B):
 * all models 与模型级周窗口(如 Fable)共用同一重置时刻,故并为一个芯片——
 * 上轨是 all models,下轨是模型级,两轨共用一道时间刻度,倒计时只写一遍。
 * 服务端未下发模型级窗口(modelPct 为 null)时退回单轨,与旧 Weekly 芯片等价。
 */
function WeeklyChip({
  pct,
  modelPct,
  modelName,
  resetsAt,
  now,
}: {
  pct: number | null;
  modelPct: number | null;
  modelName: string | null;
  resetsAt?: number | null;
  now: number;
}) {
  if (modelPct === null) {
    return <Chip label="Weekly" pct={pct} resetsAt={resetsAt} windowMs={SEVEN_DAY_MS} now={now} />;
  }
  const color = usageColor(pct);
  const mColor = usageColor(modelPct);
  const reset = untilReset(resetsAt, now);
  const timePct = resetsAt
    ? Math.min(100, Math.max(0, ((SEVEN_DAY_MS - (resetsAt - now)) / SEVEN_DAY_MS) * 100))
    : null;
  const name = modelName ?? 'Model';
  const title = [
    `Weekly(all models)${pct === null ? ' —' : ` ${pct}%`}`,
    `${name} 周限额 ${modelPct}%`,
    reset,
    timePct === null ? null : `窗口已过去 ${Math.round(timePct)}%`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="u-chip wk2" title={title}>
      <span className="u-lab">Weekly</span>
      <span className="wk2-bars">
        <span className="u-bar">
          <i style={{ width: `${pct ?? 0}%`, background: color }} />
          {timePct !== null && <span className="u-tick" style={{ left: `${timePct}%` }} aria-hidden="true" />}
        </span>
        <span className="u-bar wk2-fb">
          <i style={{ width: `${modelPct}%`, background: mColor }} />
          {timePct !== null && <span className="u-tick" style={{ left: `${timePct}%` }} aria-hidden="true" />}
        </span>
      </span>
      <span className="wk2-vals">
        <b style={pct !== null && pct >= 50 ? { color } : undefined}>
          <span className="wk2-pfx">A</span> {pct === null ? '—' : `${pct}%`}
        </b>
        <b style={modelPct >= 50 ? { color: mColor } : undefined}>
          <span className="wk2-pfx fb">{name.charAt(0)}</span> {modelPct}%
        </b>
      </span>
      {reset && <em className="u-reset">{untilResetShort(resetsAt, now)}</em>}
    </span>
  );
}

/** agent 提问卡:单选点击即答;多问/多选/自定义 → 选完提交 */
function QuestionCard({
  item,
  onAnswer,
}: {
  item: Extract<ChatItem, { t: 'question' }>;
  onAnswer: (id: string, answers: Record<string, string>) => void;
}) {
  const [sel, setSel] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const answered = item.answers;
  const single = item.questions.length === 1 && !item.questions[0]!.multiSelect;

  const submit = (answers: Record<string, string>) => onAnswer(item.requestId, answers);
  const ready = item.questions.every((q) => (custom[q.question] ?? sel[q.question] ?? '').trim());

  return (
    <div className={cn('approval qcard', answered && 'resolved')}>
      <div className="a-head">❓ Claude 提问 · AskUserQuestion</div>
      {item.questions.map((q: QuestionSpec) => (
        <div key={q.question} className="q-block">
          <div className="q-text">
            {q.header && <span className="tag">{q.header}</span>} {q.question}
          </div>
          {answered ? (
            <div className="q-answered">↳ {answered[q.question] ?? '(未答)'}</div>
          ) : (
            <>
              <div className="q-opts">
                {q.options.map((o) => (
                  <button
                    key={o.label}
                    className={cn('q-opt', sel[q.question] === o.label && 'sel')}
                    onClick={() => {
                      if (single) return submit({ [q.question]: o.label });
                      setSel((prev) => {
                        if (q.multiSelect) {
                          const cur = (prev[q.question] ?? '').split('、').filter(Boolean);
                          const next = cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label];
                          return { ...prev, [q.question]: next.join('、') };
                        }
                        return { ...prev, [q.question]: o.label };
                      });
                    }}
                  >
                    <b>{o.label}</b>
                    {o.description && <span>{o.description}</span>}
                  </button>
                ))}
              </div>
              <input
                className="q-custom"
                placeholder="或输入自定义回答…"
                value={custom[q.question] ?? ''}
                onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && single && (custom[q.question] ?? '').trim()) {
                    submit({ [q.question]: custom[q.question]!.trim() });
                  }
                  e.stopPropagation();
                }}
              />
            </>
          )}
        </div>
      ))}
      {!answered && !single && (
        <div className="a-actions">
          <button
            className="btn btn-sm btn-primary"
            disabled={!ready}
            onClick={() => {
              const answers: Record<string, string> = {};
              for (const q of item.questions) {
                answers[q.question] = (custom[q.question] ?? sel[q.question] ?? '').trim();
              }
              submit(answers);
            }}
          >
            提交回答
          </button>
        </div>
      )}
    </div>
  );
}

/** ChatRow 逐条独立 memo:d.items 每次增量都是新数组引用,不 memo 的话每个 delta 都会
 *  连带把已经渲染完的历史消息全部重渲染一遍——包括重新跑一遍它们的 Markdown 解析,是长会话
 *  流式卡顿的主因之一。item 引用不变的行(未在流式中的历史消息)据此完全跳过。 */
const ChatRow = memo(function ChatRow({
  item,
  onDecide,
  onAnswer,
  onGrow,
  onZoom,
}: {
  item: ChatItem;
  onDecide: (id: string, d: 'allow' | 'always' | 'deny') => void;
  onAnswer: (id: string, answers: Record<string, string>) => void;
  onGrow?: () => void;
  /** 点击消息里的图片缩略图 → 开灯箱看原图 */
  onZoom?: (url: string) => void;
}) {
  if (item.t === 'question') return <QuestionCard item={item} onAnswer={onAnswer} />;
  if (item.t === 'user')
    return (
      <div className="chat-msg user">
        <div className="who">你<MsgTime ts={item.ts} /></div>
        <div className="body">
          {item.images && item.images.length > 0 && (
            <div className="msg-imgs">
              {item.images.map((im, i) => (
                <img
                  key={i}
                  src={`data:${im.media_type};base64,${im.data}`}
                  alt="图片"
                  onClick={() => onZoom?.(`data:${im.media_type};base64,${im.data}`)}
                />
              ))}
            </div>
          )}
          {item.text}
        </div>
      </div>
    );
  if (item.t === 'assistant')
    return (
      <div className="chat-msg">
        <div className="who">Claude<MsgTime ts={item.ts} /></div>
        <div className="body md">
          <TypewriterMd text={item.text} streaming={item.streaming} onGrow={onGrow} />
          {item.streaming && <span className="typing"><i /><i /><i /></span>}
        </div>
      </div>
    );
  if (item.t === 'thinking')
    return <ThinkingCard text={item.text} streaming={item.streaming} durationMs={item.durationMs} />;
  if (item.t === 'tool') return <ToolCard name={item.name} input={item.input} output={item.output} isError={item.isError} />;
  if (item.t === 'approval') {
    const label =
      item.decision === 'allow' ? '✓ 已允许(仅本次)'
      : item.decision === 'always' ? '✓ 已允许(本次会话内不再询问)'
      : item.decision === 'deny' ? '✕ 已拒绝'
      : null;
    return (
      <div className={cn('approval', item.decision && 'resolved')}>
        <div className="a-head">⏸ 权限审批 · canUseTool</div>
        <div className="a-tool">{item.title}</div>
        <div className="a-actions">
          {label ? (
            <span style={{ fontSize: '0.75rem', color: item.decision === 'deny' ? 'var(--red)' : 'var(--muted)' }}>{label}</span>
          ) : (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => onDecide(item.requestId, 'allow')}>允许一次</button>
              <button className="btn btn-sm" onClick={() => onDecide(item.requestId, 'always')}>本次会话总是允许</button>
              <button className="btn btn-sm btn-danger" onClick={() => onDecide(item.requestId, 'deny')}>拒绝</button>
            </>
          )}
        </div>
      </div>
    );
  }
  if (item.t === 'note') return <div className="resume-note">{item.text}</div>;
  if (item.t === 'compact')
    return <CompactionCard trigger={item.trigger} preTokens={item.preTokens} durationMs={item.durationMs} summary={item.summary} />;
  return (
    <div className="raw-event">
      <div className="note">⚠ {item.text}</div>
    </div>
  );
});
