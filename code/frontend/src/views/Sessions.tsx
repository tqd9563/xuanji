import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { AgentSession, Replay, SessionState } from '@/api/types';
import { usePoll, isTypingTarget } from '@/lib/hooks';
import { clock } from '@/lib/utils';
import { Drawer, Empty, Pill, ProjChip, Tag, ToolCard, toast } from '@/components/shared';

const COLS: { key: SessionState; label: string }[] = [
  { key: 'idle', label: '空闲' },
  { key: 'running', label: '运行中' },
  { key: 'blocked', label: '等待输入' },
  { key: 'done', label: '已完成' },
];

export interface SessionsHandle {
  openReplay: (sessionId: string) => void;
}

export function Sessions({
  active,
  registerHandle,
}: {
  active: boolean;
  registerHandle?: (h: SessionsHandle) => void;
}) {
  const { data } = usePoll(api.sessions, 5_000);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayFor, setReplayFor] = useState<AgentSession | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [kbPos, setKbPos] = useState<{ c: number; r: number } | null>(null);

  const columns = data?.columns;

  const openReplay = useCallback(
    async (sessionId: string, session?: AgentSession) => {
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
  const kbRef = useRef({ kbPos, columns, drawerOpen });
  kbRef.current = { kbPos, columns, drawerOpen };
  useEffect(() => {
    if (!active) return;
    const cardsIn = (c: number) => kbRef.current.columns?.[COLS[c]!.key] ?? [];
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || kbRef.current.drawerOpen) return;
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
        // Space / Enter:M1 全部进入只读回放(派发续接是 M2)
        const s = cardsIn(pos.c)[pos.r];
        if (s) {
          if (s.readonly) toast('终端存活的交互会话只读,已打开回放');
          void openReplay(s.sessionId, s);
        }
        return;
      }
      setKbPos(pos);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, openReplay]);

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
            <span className="mono">← ↑ ↓ →</span> 选卡,<span className="mono">Space</span> 回放,
            <span className="mono">Esc</span> 关闭
          </>
        ) : (
          '加载中…'
        )}
      </div>
      <div className="board">
        {COLS.map((col, ci) => {
          const items = columns?.[col.key] ?? [];
          return (
            <div key={col.key}>
              <div className="col-head">
                <Pill state={col.key} />
                <span className="n">{items.length}</span>
              </div>
              {items.map((s, ri) => (
                <div
                  key={s.id}
                  className={`scard ${kbPos?.c === ci && kbPos?.r === ri ? 'kb-sel' : ''}`}
                  role="button"
                  tabIndex={0}
                  title={`${s.name}${s.detail ? ' — ' + s.detail : ''}`}
                  onClick={() => void openReplay(s.sessionId, s)}
                >
                  <div className="top">
                    <span className="title">{s.name}</span>
                    <Tag>{s.kind === 'background' ? '后台' : '终端'}</Tag>
                    {s.readonly && <Tag>只读</Tag>}
                  </div>
                  <div className="cwd">
                    <ProjChip name={s.project} path={s.cwd} />
                    <span className="sid">{s.id}</span>
                  </div>
                  {s.detail && <div className="detail">{s.detail}</div>}
                  {s.needs && <div className="needs">⏸ {s.needs}</div>}
                  <div className="foot">
                    <span className="time">{clock(s.startedAt)} 开始</span>
                  </div>
                </div>
              ))}
              {items.length === 0 && (
                <div className="empty" style={{ padding: '24px 12px' }}><p>暂无</p></div>
              )}
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
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
            只读回放 · source of truth 在 ~/.claude
            {replay && replay.skippedLines > 0 && ` · ${replay.skippedLines} 行无法解析已跳过`}
            {' '}· 续接与回复在 M2 开放
          </span>
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
              <div className="body">{ev.text}</div>
            </div>
          );
        })}
        {replay && replay.events.length === 0 && <Empty><p>此会话没有可回放的事件。</p></Empty>}
      </Drawer>
    </>
  );
}
