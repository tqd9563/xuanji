import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@/api/client';
import { usePoll, isTypingTarget } from '@/lib/hooks';
import { takeDispatchIntent, useDispatch, type ChatItem, type QuestionSpec } from '@/lib/dispatch';
import { cn, fmtCost, markSeen } from '@/lib/utils';
import { DropUp } from '@/components/DropUp';
import { ToolCard, toast } from '@/components/shared';
import type { ReplayEvent } from '@/api/types';

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

export function Dispatch({ active }: { active: boolean }) {
  const d = useDispatch();
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const [cwd, setCwd] = useState<string>('');
  const [modelSel, setModelSel] = useState(initialModel);
  const [permSel, setPermSel] = useState(DEFAULT_PERM);
  const [bg, setBg] = useState(false);
  const [resumeInfo, setResumeInfo] = useState<{ sessionId: string; name: string; cwd: string } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [sessionCwd, setSessionCwd] = useState<string | null>(null);
  const [fromBoard, setFromBoard] = useState(false);

  const projects = projectsData?.projects ?? [];
  const cwdOptions = useMemo(() => projects.map((p) => p.path), [projects]);
  const curProject = projects.find((p) => p.path === (cwd || cwdOptions[0]));
  const effectiveCwd = cwd || cwdOptions[0] || '';

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
      setResumeInfo(null);
      setSessionCwd(null);
      if (wasLive) toast('上一个会话仍在后台运行,可在「会话」页接回');
    }
    if (intent?.attach) {
      // 换会话先清当前状态,避免输入串进旧会话
      if (d.started) d.reset();
      setResumeInfo(null);
      setSessionCwd(intent.attach.cwd);
      setCwd(intent.attach.cwd);
      setFromBoard(true);
      void d.attach(intent.attach.dispatchId);
    } else if (intent?.resume) {
      if (d.started || d.items.length > 0) d.reset();
      setSessionCwd(null);
      setResumeInfo(intent.resume);
      setCwd(intent.resume.cwd);
      setFromBoard(true);
      d.pushNote(`↻ 将续接会话 ${intent.resume.sessionId.slice(0, 8)}(${intent.resume.name}),发送第一条消息后恢复上下文。`);
      // 装载历史对话(原型既有设计,M1 移植时丢失):失败静默(未开始的会话没有转录)
      void api
        .replay(intent.resume.sessionId)
        .then((r) => d.seedHistory(replayToChat(r.events)))
        .catch(() => {});
    }
    if (intent?.prefill && taRef.current) taRef.current.value = intent.prefill;
    setTimeout(() => taRef.current?.focus(), 0);
  }, [active, d]);

  // 消息区自动滚底
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [d.items]);

  // 正在看着这个会话 = 已验收到当下:之后若有新产出会重新点亮「待验收」
  useEffect(() => {
    if (active && d.sessionId) markSeen(d.sessionId);
  }, [active, d.sessionId, d.status.state, d.costUsd]);

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

  const submit = async () => {
    const ta = taRef.current;
    const text = ta?.value.trim();
    if (!text || !effectiveCwd) return;
    ta!.value = '';
    // /rename 是终端专属命令,SDK 环境不可用 → 拦截为璇玑自己的改名(display-name 存自有 SQLite)
    if (/^\/rename\b/.test(text)) {
      const newName = text.replace(/^\/rename\b/, '').trim();
      if (!newName) return toast('用法:/rename 新的会话名');
      if (!d.sessionId) return toast('会话尚未开始,发送第一条消息后再改名');
      try {
        await api.renameSession(d.sessionId, newName);
        d.pushNote(`✎ 会话已重命名为「${newName}」(存璇玑本地,看板即时生效;不写 ~/.claude)`);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // /model 切换模型:未开始 → 设定下一会话;已开始 → SDK setModel 中途切换
    if (/^\/model\b/.test(text)) {
      const arg = text.replace(/^\/model\b/, '').trim().toLowerCase();
      if (!arg) return toast(`当前模型:${d.model ?? modelSel} · 用法:/model fable|opus|sonnet|haiku 或完整模型名`);
      const resolved = MODELS.find((m) => m.toLowerCase() === arg) ?? MODEL_SHORT[arg];
      if (!resolved || resolved === MODELS[0]) return toast(`不认识的模型「${arg}」,可选:fable / opus / sonnet / haiku`);
      setModelSel(resolved);
      localStorage.setItem(LAST_MODEL_KEY, resolved);
      if (d.started) d.changeModel(resolved);
      else d.pushNote(`⇄ 模型已设为 ${resolved},本会话生效。`);
      return;
    }
    if (modelSel !== MODELS[0]) localStorage.setItem(LAST_MODEL_KEY, modelSel);
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
    setResumeInfo(null);
    setSessionCwd(null);
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
      setResumeInfo(null);
      setSessionCwd(target);
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
        {d.sessionId && <span className="sub mono">session {d.sessionId.slice(0, 8)}</span>}
        <span className="spacer" />
        <button className="btn" title="⌘N" onClick={newSession}>新会话</button>
      </div>
      <div className="dispatch">
        <div className="chat" ref={chatRef}>
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
          <span className="u-chips">
            <Chip label="Context" pct={d.chips.contextPct} />
            <Chip label="Usage" pct={d.chips.fiveHourPct} />
            <Chip label="Weekly" pct={d.chips.sevenDayPct} />
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
          />
          <div className="c-bar">
            <span className="hint">Enter 发送 · Shift+Enter 换行</span>
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
          <DropUp id="model-dd" value={modelSel} options={MODELS} onChange={setModelSel} title="派发会话所用模型,默认继承 settings.json" />
          <DropUp
            className="dim"
            value={permSel}
            options={PERMS}
            onChange={setPermSel}
            title="权限模式,对下一个新会话生效:default 逐项审批 · acceptEdits 自动放行文件编辑 · bypassPermissions 全部免审批(信任任务时用) · plan 只规划不执行"
          />
          <span className="tag">settingSources: user</span>
        </div>
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

function Chip({ label, pct }: { label: string; pct: number | null }) {
  const over = pct !== null && pct >= 60;
  return (
    <span className="u-chip" title={pct === null ? '会话产生用量数据后显示' : undefined}>
      {label}{' '}
      <span className="u-bar">
        <i style={{ width: `${pct ?? 0}%`, background: over ? 'var(--amber)' : undefined }} />
      </span>
      <b style={over ? { color: 'var(--amber)' } : undefined}>{pct === null ? '—' : `${pct}%`}</b>
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

function ChatRow({
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
          <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
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
}
