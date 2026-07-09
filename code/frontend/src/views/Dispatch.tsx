import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/client';
import { usePoll, isTypingTarget } from '@/lib/hooks';
import { takeDispatchIntent, useDispatch, type ChatItem } from '@/lib/dispatch';
import { cn, fmtCost } from '@/lib/utils';
import { DropUp } from '@/components/DropUp';
import { ToolCard, toast } from '@/components/shared';

const MODELS = ['(默认)', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const PERMS = ['default(逐项审批)', 'acceptEdits', 'bypassPermissions(免审批)', 'plan'];
const PERM_VALUE: Record<string, string> = {
  'default(逐项审批)': 'default',
  acceptEdits: 'acceptEdits',
  'bypassPermissions(免审批)': 'bypassPermissions',
  plan: 'plan',
};

export function Dispatch({ active }: { active: boolean }) {
  const d = useDispatch();
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const [cwd, setCwd] = useState<string>('');
  const [modelSel, setModelSel] = useState(MODELS[0]!);
  const [permSel, setPermSel] = useState(PERMS[0]!);
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

  // 进入视图:接收跳转意图(看板续接/attach 接回/交接)并聚焦输入框;离开即清除来路,返回按钮随之隐藏
  useEffect(() => {
    if (!active) {
      setFromBoard(false);
      return;
    }
    const intent = takeDispatchIntent();
    if (intent?.attach) {
      // 换会话先清当前状态,避免输入串进旧会话
      if (d.started) d.reset();
      setResumeInfo(null);
      setSessionCwd(intent.attach.cwd);
      setCwd(intent.attach.cwd);
      setFromBoard(true);
      void d.attach(intent.attach.dispatchId);
    } else if (intent?.resume) {
      if (d.started) d.reset();
      setSessionCwd(null);
      setResumeInfo(intent.resume);
      setCwd(intent.resume.cwd);
      setFromBoard(true);
      d.pushNote(`↻ 将续接会话 ${intent.resume.sessionId.slice(0, 8)}(${intent.resume.name}),发送第一条消息后恢复上下文。`);
    }
    if (intent?.prefill && taRef.current) taRef.current.value = intent.prefill;
    setTimeout(() => taRef.current?.focus(), 0);
  }, [active, d]);

  // 消息区自动滚底
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [d.items]);

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
    taRef.current?.focus();
  };

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
        return { text: `等待你审批:${d.status.detail ?? ''}`, cls: 'wait' };
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
        <button className="btn" onClick={newSession}>新会话</button>
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
            <ChatRow key={i} item={item} onDecide={d.decide} />
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

function ChatRow({ item, onDecide }: { item: ChatItem; onDecide: (id: string, d: 'allow' | 'always' | 'deny') => void }) {
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
        <div className="body" style={{ whiteSpace: 'pre-wrap' }}>
          {item.text}
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
