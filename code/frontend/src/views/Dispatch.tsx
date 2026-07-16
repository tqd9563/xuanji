import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '@/api/client';
import { usePoll, isTypingTarget } from '@/lib/hooks';
import { takeDispatchIntent, useDispatch, type ChatItem, type QuestionSpec } from '@/lib/dispatch';
import { cn, fmtCost, markSeen, projHue } from '@/lib/utils';
import { DropUp } from '@/components/DropUp';
import { ResumePalette } from '@/components/ResumePalette';
import { WdPalette } from '@/components/WdPalette';
import { Md, ToolCard, toast } from '@/components/shared';
import type { ClosedSession, ReplayEvent } from '@/api/types';

/** 只读回放事件 → 派发页消息(续接时装载历史,取尾部 200 条) */
function replayToChat(events: ReplayEvent[]): ChatItem[] {
  return events.slice(-200).map((ev, i): ChatItem => {
    if (ev.kind === 'user') return { t: 'user', text: ev.text };
    if (ev.kind === 'assistant') return { t: 'assistant', text: ev.text, streaming: false };
    if (ev.kind === 'tool')
      return { t: 'tool', id: `hist-${i}`, name: ev.name, input: ev.input, output: ev.output, isError: ev.isError };
    return { t: 'note', text: `⚠ 未知事件「${ev.type}」(原始记录见回放页)` };
  });
}

const MODELS = ['(默认)', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
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
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};
/** 模型默认沿用最近一次用过的,兜底 opus */
const LAST_MODEL_KEY = 'xuanji-last-model';
const initialModel = (): string => {
  const saved = localStorage.getItem(LAST_MODEL_KEY);
  return saved && MODELS.includes(saved) && saved !== MODELS[0] ? saved : 'claude-opus-4-8';
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
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const [cwd, setCwd] = useState<string>('');
  const [modelSel, setModelSel] = useState(initialModel);
  const [permSel, setPermSel] = useState(DEFAULT_PERM);
  const [bg, setBg] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<{ sessionId: string; name: string; cwd: string; project: string } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [resumePalette, setResumePalette] = useState(false);
  const [wdPalette, setWdPalette] = useState(false);
  const [wdQuery, setWdQuery] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 输入框历史回溯:取材于当前会话自己的 d.items(t:'user'),天然按会话隔离——
  // 新会话/续接切会话时 d.items 会被清空或替换(reset/attach/seedHistory),不会跨会话残留。
  // historyIdxRef === null 表示「未在浏览,停在当前草稿」;否则是 hist 数组下标(0=最早)。
  const historyIdxRef = useRef<number | null>(null);
  const historyDraftRef = useRef<string>('');
  const chatRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // 用户是否钉在消息区底部(详见下方自动滚底效应)
  const lastChatTopRef = useRef(0); // 上次观察到的消息区 scrollTop,用于判定滚动方向
  const repin = () => {
    pinnedRef.current = true;
    lastChatTopRef.current = 0;
  };
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
    }
    if (intent?.prefill && taRef.current) taRef.current.value = intent.prefill;
    setTimeout(() => taRef.current?.focus(), 0);
  }, [active, d]);

  // 消息区自动滚底 —— 仅当用户钉在底部时跟随。
  // 修复:流式输出期间向上翻历史,每条新增量都把视口拽回底部,历史根本没法看。
  // 解钉/回钉用「滚动方向」判定而非只看距底距离:程序滚底后 scroll 事件异步派发,
  // 快速流式下事件到达时内容又长高了,按距离判会把程序滚底误判成"离开了底部"而自我解钉。
  // scrollTop 变小 = 用户向上翻(程序滚底只会变大,天然免疫)→ 解钉;滚回距底 <48px → 回钉,自愈无需按钮。
  // 会话切换类动作(发送/续接/接回/新会话/交接)一律重新钉住:那是用户主动回到「看最新」。
  const onChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    const prev = lastChatTopRef.current;
    lastChatTopRef.current = el.scrollTop;
    if (el.scrollTop < prev - 1) pinnedRef.current = false;
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) pinnedRef.current = true;
  };
  useEffect(() => {
    if (pinnedRef.current) chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [d.items]);

  // 正在看着这个会话 = 已验收到当下:之后若有新产出会重新点亮「待验收」
  useEffect(() => {
    if (active && d.sessionId) markSeen(d.sessionId);
  }, [active, d.sessionId, d.status.state, d.costUsd]);

  // SDK 分配 sessionId(init 事件)后补上会话标识里悬空的 id——新会话首次发送、attach 重放 init 均走这里
  useEffect(() => {
    if (!d.sessionId) return;
    setSessCtx((prev) => (prev && prev.id === null ? { ...prev, id: d.sessionId } : prev));
  }, [d.sessionId]);

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
    const pos = ta.value.length;
    ta.setSelectionRange(pos, pos);
  };

  const submit = async () => {
    const ta = taRef.current;
    const text = ta?.value.trim();
    if (!text || !effectiveCwd) return;
    ta!.value = '';
    resetHistoryBrowse();
    // /resume 恢复已关闭会话:弹窗列出当前项目的隐藏会话,选中即 unhide + 续接
    if (/^\/resume\b/.test(text)) {
      setResumePalette(true);
      return;
    }
    // /wd 切换工作目录:弹窗模糊搜索历史项目目录,↑↓ 选中即改新会话 cwd。
    // 支持 /wd <关键词> 直接带初始搜索词(如 /wd skill)。
    if (/^\/wd\b/.test(text)) {
      setWdQuery(text.replace(/^\/wd\b/, '').trim());
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
    // /model 切换模型:已开始 → 只对当前会话 SDK setModel(不改新会话默认);未开始 → 设定新会话默认并记忆
    if (/^\/model\b/.test(text)) {
      const arg = text.replace(/^\/model\b/, '').trim().toLowerCase();
      if (!arg) return toast(`当前模型:${d.model ?? modelSel} · 用法:/model fable|opus|sonnet|haiku 或完整模型名`);
      const resolved = MODELS.find((m) => m.toLowerCase() === arg) ?? MODEL_SHORT[arg];
      if (!resolved || resolved === MODELS[0]) return toast(`不认识的模型「${arg}」,可选:fable / opus / sonnet / haiku`);
      if (d.started) {
        d.changeModel(resolved); // 仅当前会话
      } else {
        setModelSel(resolved);
        localStorage.setItem(LAST_MODEL_KEY, resolved);
        d.pushNote(`⇄ 模型已设为 ${resolved},本会话生效。`);
      }
      return;
    }
    if (modelSel !== MODELS[0]) localStorage.setItem(LAST_MODEL_KEY, modelSel);
    // 续接发送沿用 applyResume 已定好的标识;全新会话在此刻就知道名称(取自首条消息)与项目,不必等 SDK 分配 id。
    // 仅在 sessCtx 尚未建立时(真正的第一条消息)才用 prompt 占位命名 —— 否则 attach/续接已带
    // 正确名称进来后,发第二条及以后的消息会用当次 prompt 把已有会话名覆盖掉(bug: 输入框上方短暂显示成刚发的话)。
    if (!resumeInfo && !sessCtx) {
      setSessCtx({ id: null, name: text.slice(0, 40), project: curProject?.name ?? effectiveCwd, cwd: effectiveCwd });
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
        resume: resumeInfo?.sessionId,
        name: resumeInfo?.name ?? text.slice(0, 40),
      });
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
          {d.items.length === 0 && (
            <div className="chat-empty">
              <h2>派发一个新任务</h2>
              <p>
                会话经 Agent SDK 执行,加载与终端一致的 skills / MCP / CLAUDE.md;工具调用逐项经你审批。
                转后台的任务建议写全任务描述并放宽权限模式,避免无人值守时卡在审批上。
              </p>
              <div className="sugg">
                <button onClick={() => { taRef.current!.value = '扫描近 7 天的高风险 IP,输出报告'; taRef.current?.focus(); }}>扫描高风险 IP</button>
                <button onClick={() => { taRef.current!.value = '用 baize 对昨日收入异动做归因,结果发飞书卡片'; taRef.current?.focus(); }}>收入异动归因</button>
                <button onClick={() => { taRef.current!.value = '把本周会话里踩过的坑提炼成 memory 草稿'; taRef.current?.focus(); }}>提炼本周经验</button>
              </div>
            </div>
          )}
          {d.items.map((item, i) => (
            <ChatRow key={i} item={item} onDecide={d.decide} onAnswer={d.answer} />
          ))}
        </div>

        <div className="chat-status">
          {sessCtx && <SessCtxBadge ctx={sessCtx} />}
          <span className="u-chips">
            <Chip label="Context" pct={d.chips.contextPct} />
            <Chip label="Usage" pct={d.chips.fiveHourPct} resetsAt={d.chips.fiveHourResetsAt} />
            <Chip label="Weekly" pct={d.chips.sevenDayPct} resetsAt={d.chips.sevenDayResetsAt} />
          </span>
          <span className={cn('cs-state', statusText.cls)}>
            <span className="cs-dot" />
            {statusText.text}
          </span>
        </div>

        <div className="composer">
          <textarea
            ref={taRef}
            rows={2}
            placeholder="描述要派发的任务…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
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
            }}
          />
          <div className="c-bar">
            <span className="hint">Enter 发送 · Shift+Enter 换行 · ↑↓ 历史</span>
            {d.status.state === 'working' && (
              <button className="btn btn-sm" onClick={d.interrupt}>打断</button>
            )}
            <label className="bg-opt">
              <span
                className={cn('switch', bg && 'on')}
                role="switch"
                aria-checked={bg}
                tabIndex={0}
                onClick={() => setBg(!bg)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBg(!bg); } }}
              />
              转后台(--bg)
            </label>
            <button className="btn btn-primary" onClick={() => void submit()}>发送</button>
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

/** 用量三档取色:<50% 玉(健康)/ 50–75% 琥珀(注意)/ ≥75% 红(告警) */
function usageColor(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  if (pct >= 75) return 'var(--red)';
  if (pct >= 50) return 'var(--amber)';
  return 'var(--jade-dim)';
}

/** 剩余重置时长:resetsAt(ms) → 「Xh Ym 后重置」/「Ym 后重置」 */
function untilReset(resetsAt: number | null | undefined): string | null {
  if (!resetsAt) return null;
  const ms = resetsAt - Date.now();
  if (ms <= 0) return '即将重置';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h > 0 ? `${h}h ` : ''}${m}m 后重置`;
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

function Chip({
  label,
  pct,
  resetsAt,
}: {
  label: string;
  pct: number | null;
  resetsAt?: number | null;
}) {
  const color = usageColor(pct);
  const alert = pct !== null && pct >= 50;
  const reset = untilReset(resetsAt);
  const title =
    pct === null ? '会话产生用量数据后显示' : [`${label} ${pct}%`, reset].filter(Boolean).join(' · ');
  return (
    <span className="u-chip" title={title}>
      {label}{' '}
      <span className="u-bar">
        <i style={{ width: `${pct ?? 0}%`, background: color }} />
      </span>
      <b style={alert ? { color } : undefined}>{pct === null ? '—' : `${pct}%`}</b>
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
}: {
  item: ChatItem;
  onDecide: (id: string, d: 'allow' | 'always' | 'deny') => void;
  onAnswer: (id: string, answers: Record<string, string>) => void;
}) {
  if (item.t === 'question') return <QuestionCard item={item} onAnswer={onAnswer} />;
  if (item.t === 'user')
    return (
      <div className="chat-msg user">
        <div className="who">你</div>
        <div className="body">{item.text}</div>
      </div>
    );
  if (item.t === 'assistant')
    return (
      <div className="chat-msg">
        <div className="who">Claude</div>
        <div className="body md">
          {/* 流式中:纯文本渲染,避免每帧对着还在增长的全文重新跑 remark 解析(O(n²));
              回合结束(streaming=false)才切到共享 Md 组件(统一 gfm + 链接新窗口打开),那时文本已定长,只解析一次。 */}
          {item.streaming ? <div className="md-plain">{item.text}</div> : <Md>{item.text}</Md>}
          {item.streaming && <span className="typing"><i /><i /><i /></span>}
        </div>
      </div>
    );
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
  return (
    <div className="raw-event">
      <div className="note">⚠ {item.text}</div>
    </div>
  );
});
