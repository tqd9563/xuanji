import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@/api/client';
import type { AgentSession, Replay, SessionState } from '@/api/types';
import { usePoll, isTypingTarget } from '@/lib/hooks';
import { setDispatchIntent } from '@/lib/dispatch';
import { clock, isUnread, markSeen, timeAgo } from '@/lib/utils';
import { Drawer, Empty, Pill, ProjChip, Tag, ToolCard, confirmBox, toast } from '@/components/shared';

/** 智能进入:后端存活的派发会话 → attach 接回;可续接 → 派发页续接;终端只读 → 回放(所有权规则) */
function smartOpen(s: AgentSession, openReplay: (id: string, s: AgentSession) => void) {
  if (s.dispatchId) {
    setDispatchIntent({ attach: { dispatchId: s.dispatchId, cwd: s.cwd } });
    location.hash = 'dispatch';
    return;
  }
  if (s.readonly) {
    toast('终端存活的交互会话只读,已打开回放');
    openReplay(s.sessionId, s);
    return;
  }
  setDispatchIntent({ resume: { sessionId: s.sessionId, name: s.name, cwd: s.cwd } });
  location.hash = 'dispatch';
}

const COLS: { key: SessionState; label: string }[] = [
  { key: 'idle', label: '空闲' },
  { key: 'running', label: '运行中' },
  { key: 'blocked', label: '等待输入' },
  { key: 'done', label: '已完成' },
];

/** 已完成 = 归档:默认展示最近条数,更早的折叠 */
const DONE_RECENT = 5;

export interface SessionsHandle {
  openReplay: (sessionId: string) => void;
}

/** 关闭会话:自有隐藏列表(~/.claude 不动);存活的 web 派发会话额外终止其进程 */
async function closeSession(s: AgentSession, refresh: () => void) {
  const msg = s.dispatchId
    ? `结束派发会话「${s.name}」?\n其进程将被终止并从看板移除,已生成的记录仍可回放/续接。`
    : `从看板移除会话「${s.name}」?\n仅在璇玑隐藏,~/.claude 数据与终端不受影响。`;
  if (!(await confirmBox(msg))) return;
  try {
    await api.closeSession(s.sessionId);
    toast(`已关闭 ${s.name}`);
    refresh();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

export function Sessions({
  active,
  registerHandle,
}: {
  active: boolean;
  registerHandle?: (h: SessionsHandle) => void;
}) {
  const { data, refresh } = usePoll(api.sessions, 5_000);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayFor, setReplayFor] = useState<AgentSession | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [kbPos, setKbPos] = useState<{ c: number; r: number } | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);

  // 待验收(未读)排列顶:注意力优先(键盘导航与渲染共用同一排序)
  const columns = useMemo(() => {
    if (!data) return undefined;
    const out = { ...data.columns };
    for (const key of Object.keys(out) as SessionState[]) {
      out[key] = [...out[key]].sort((a, b) => Number(isUnread(b)) - Number(isUnread(a)));
    }
    return out;
  }, [data]);

  // 键盘选卡跟随滚动:选中卡始终保持在视口内
  useEffect(() => {
    if (kbPos) document.querySelector('.scard.kb-sel')?.scrollIntoView({ block: 'nearest' });
  }, [kbPos]);

  const openReplay = useCallback(
    async (sessionId: string, session?: AgentSession) => {
      markSeen(sessionId); // 看过回放 = 已验收,「待验收」标记熄灭
      setDrawerOpen(true);
      setReplayFor(session ?? null);
      setReplay(null);
      try {
        setReplay(await api.replay(sessionId));
      } catch {
        toast(
          session?.needs?.includes('send a prompt')
            ? '该会话尚未开始,还没有可回放的内容'
            : '回放不可用:会话记录不存在或已清理',
        );
        setDrawerOpen(false);
      }
    },
    [],
  );

  useEffect(() => {
    registerHandle?.({ openReplay: (id) => void openReplay(id) });
  }, [registerHandle, openReplay]);

  /** 键盘导航:方向键选卡(跳过空列),Space/Enter 打开回放,对齐 claude agents TUI */
  const kbRef = useRef({ kbPos, columns, drawerOpen, doneOpen });
  kbRef.current = { kbPos, columns, drawerOpen, doneOpen };
  useEffect(() => {
    if (!active) return;
    // 已完成折叠区里的卡不参与键盘导航
    const cardsIn = (c: number) => {
      const arr = kbRef.current.columns?.[COLS[c]!.key] ?? [];
      if (COLS[c]!.key === 'done' && !kbRef.current.doneOpen) return arr.slice(0, DONE_RECENT);
      return arr;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || kbRef.current.drawerOpen) return;
      // Ctrl+X 关闭当前选中会话
      if (e.ctrlKey && (e.key === 'x' || e.key === 'X')) {
        const pos = kbRef.current.kbPos;
        const s = pos ? cardsIn(pos.c)[pos.r] : undefined;
        if (s && !s.readonly) {
          e.preventDefault();
          void closeSession(s, refresh);
        }
        return;
      }
      if (![' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      let pos = kbRef.current.kbPos;
      if (!pos) {
        const c = COLS.findIndex((_, i) => cardsIn(i).length > 0);
        if (c === -1) return;
        setKbPos({ c, r: 0 });
        return;
      }
      pos = { ...pos };
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        let c = pos.c;
        do {
          c += dir;
        } while (c >= 0 && c < COLS.length && cardsIn(c).length === 0);
        if (c < 0 || c >= COLS.length || cardsIn(c).length === 0) return;
        pos = { c, r: Math.min(pos.r, cardsIn(c).length - 1) };
      } else if (e.key === 'ArrowUp') {
        pos.r = Math.max(0, pos.r - 1);
      } else if (e.key === 'ArrowDown') {
        pos.r = Math.min(cardsIn(pos.c).length - 1, pos.r + 1);
      } else {
        // Space / Enter:智能进入(可续接 → 派发,只读 → 回放)
        const s = cardsIn(pos.c)[pos.r];
        if (s) smartOpen(s, (id, sess) => void openReplay(id, sess));
        return;
      }
      setKbPos(pos);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, openReplay, refresh]);

  return (
    <>
      <div className="view-head">
        <h1>会话</h1>
        <span className="spacer" />
      </div>
      <div className="notice">
        <span className="ok" style={data && !data.ok ? { background: 'var(--red)' } : undefined} />
        {data ? (
          <>
            经 <span className="mono">claude agents --json --all</span> 刷新于{' '}
            {Math.max(0, Math.round((Date.now() - data.refreshedAt) / 1000))} 秒前 · 终端存活的交互会话仅只读展示 ·{' '}
            <span className="mono">← ↑ ↓ →</span> 选卡,<span className="mono">Space</span> 进入,
            <span className="mono">Ctrl+X</span> 关闭会话,<span className="mono">Esc</span> 关抽屉
          </>
        ) : (
          '加载中…'
        )}
      </div>
      <div className="board">
        {COLS.map((col, ci) => {
          const items = columns?.[col.key] ?? [];
          const isDone = col.key === 'done';
          const olderCount = isDone ? Math.max(0, items.length - DONE_RECENT) : 0;

          const xClose = (s: AgentSession) =>
            !s.readonly && (
              <button
                className="x-close"
                title="关闭会话(Ctrl+X)"
                aria-label={`关闭会话 ${s.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeSession(s, refresh);
                }}
              >
                ×
              </button>
            );

          /** 已完成 = 归档:两行紧凑卡(标题 / 项目+时间),概要在悬停提示与回放页 */
          const compactCard = (s: AgentSession, ri: number) => (
            <div
              key={s.id}
              className={`scard compact ${kbPos?.c === ci && kbPos?.r === ri ? 'kb-sel' : ''}`}
              role="button"
              tabIndex={0}
              title={`${s.name}${s.detail ? ' — ' + s.detail : ''}`}
              onClick={() => void openReplay(s.sessionId, s)}
            >
              <div className="top">
                {isUnread(s) && <span className="u-dot" />}
                <span className="title">{s.name}</span>
                {isUnread(s) && <span className="tag t-unread">待验收</span>}
                {xClose(s)}
              </div>
              <div className="cwd">
                <ProjChip name={s.project} path={s.cwd} />
                <span className="ctime">{timeAgo(s.startedAt)}</span>
              </div>
            </div>
          );

          const fullCard = (s: AgentSession, ri: number) => (
            <div
              key={s.id}
              className={`scard ${kbPos?.c === ci && kbPos?.r === ri ? 'kb-sel' : ''}`}
              role="button"
              tabIndex={0}
              title={`${s.name}${s.detail ? ' — ' + s.detail : ''}`}
              onClick={() => void openReplay(s.sessionId, s)}
            >
              <div className="top">
                {isUnread(s) && <span className="u-dot" />}
                <span className="title">{s.name}</span>
                {isUnread(s) && <span className="tag t-unread">待验收</span>}
                <Tag>{s.source === 'web' ? 'web' : s.kind === 'background' ? '后台' : '终端'}</Tag>
                {s.readonly && <Tag>只读</Tag>}
                {xClose(s)}
              </div>
              <div className="cwd">
                <ProjChip name={s.project} path={s.cwd} />
                <span className="sid">{s.id}</span>
              </div>
              {s.detail && <div className="detail">{s.detail}</div>}
              {s.needs && <div className="needs">⏸ {s.needs}</div>}
              <div className="foot">
                {s.state === 'blocked' && !s.readonly && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      smartOpen(s, (id, sess) => void openReplay(id, sess));
                    }}
                  >
                    去回复
                  </button>
                )}
                <span className="time">{clock(s.startedAt)} 开始</span>
              </div>
            </div>
          );

          const card = isDone ? compactCard : fullCard;
          return (
            <div key={col.key}>
              <div className="col-head">
                <Pill state={col.key} />
                <span className="n">{items.length}</span>
              </div>
              <div className="col-body">
                {items.slice(0, isDone ? DONE_RECENT : undefined).map((s, ri) => card(s, ri))}
                {olderCount > 0 && (
                  <button className="col-more" onClick={() => setDoneOpen(!doneOpen)}>
                    {doneOpen ? '收起 ▴' : `更早的 ${olderCount} 条 ▾`}
                  </button>
                )}
                {isDone && doneOpen && items.slice(DONE_RECENT).map((s, i) => card(s, DONE_RECENT + i))}
                {items.length === 0 && (
                  <div className="empty" style={{ padding: '24px 12px' }}><p>暂无</p></div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={replay?.title ?? replayFor?.name ?? '会话回放'}
        meta={
          replayFor && (
            <>
              <Pill state={replayFor.state} />
              <Tag>{replayFor.kind === 'background' ? '后台' : '终端'}</Tag>
              <span className="mono">{replayFor.cwd}</span>
              <span className="mono">session {replayFor.id}</span>
            </>
          )
        }
        foot={
          <>
            {replayFor && !replayFor.readonly && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  setDrawerOpen(false);
                  smartOpen(replayFor, (id, sess) => void openReplay(id, sess));
                }}
              >
                续接此会话(--resume)
              </button>
            )}
            <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
              只读回放 · source of truth 在 ~/.claude
              {replay && replay.skippedLines > 0 && ` · ${replay.skippedLines} 行无法解析已跳过`}
              {replayFor?.readonly && ' · 终端存活会话不可接管'}
            </span>
          </>
        }
      >
        {!replay && <Empty><p>回放加载中…</p></Empty>}
        {replay?.events.map((ev, i) => {
          if (ev.kind === 'tool') return <ToolCard key={i} {...ev} />;
          if (ev.kind === 'raw')
            return (
              <div className="raw-event" key={i}>
                <div className="note">⚠ 未知事件类型「{ev.type}」,已按原始文本降级展示(adapter 兜底)</div>
                {ev.json}
              </div>
            );
          return (
            <div className="replay-msg" key={i}>
              <div className={`who ${ev.kind === 'user' ? 'u' : ''}`}>{ev.kind === 'user' ? '你' : 'Claude'}</div>
              {ev.kind === 'assistant' ? (
                <div className="body md">
                  <Markdown remarkPlugins={[remarkGfm]}>{ev.text}</Markdown>
                </div>
              ) : (
                <div className="body">{ev.text}</div>
              )}
            </div>
          );
        })}
        {replay && replay.events.length === 0 && <Empty><p>此会话没有可回放的事件。</p></Empty>}
      </Drawer>
    </>
  );
}
