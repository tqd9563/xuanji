import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { api } from '@/api/client';
import type { AgentSession, Replay, SessionState } from '@/api/types';
import { usePoll, isTypingTarget, useIsMobile } from '@/lib/hooks';
import { setDispatchIntent } from '@/lib/dispatch';
import { clock, isUnread, markSeen, timeAgo } from '@/lib/utils';
import { Drawer, Empty, Md, Pill, ProjChip, Tag, ToolCard, confirmBox, toast } from '@/components/shared';

/** 智能进入:后端存活的派发会话 → attach 接回;可续接 → 派发页续接;终端只读 → 回放(所有权规则) */
function smartOpen(s: AgentSession, openReplay: (id: string, s: AgentSession) => void) {
  if (s.dispatchId) {
    setDispatchIntent({ attach: { dispatchId: s.dispatchId, cwd: s.cwd, name: s.name, project: s.project } });
    location.hash = 'dispatch';
    return;
  }
  if (s.readonly) {
    toast('终端存活的交互会话只读,已打开回放');
    openReplay(s.sessionId, s);
    return;
  }
  setDispatchIntent({ resume: { sessionId: s.sessionId, name: s.name, cwd: s.cwd, project: s.project } });
  location.hash = 'dispatch';
}

/** 列序 = 注意力流:进行态在左,验收收件箱居中逼处置,停车场(空闲)与归档(已完成)靠右收纳 */
const COLS: { key: SessionState; label: string }[] = [
  { key: 'running', label: '运行中' },
  { key: 'blocked', label: '等待输入' },
  { key: 'review', label: '验收中' },
  { key: 'idle', label: '空闲' },
  { key: 'done', label: '已完成' },
];

/** 移动端状态 tab 顺序与文案:「需要你」优先(与 DESIGN.md 移动端章节同源),
 *  取代桌面 4×272px 横向滚动看板——重新组织信息架构而非缩放同一个网格。 */
const MOBILE_TABS: { key: SessionState; label: string; warn?: boolean }[] = [
  { key: 'blocked', label: '需要你', warn: true },
  { key: 'review', label: '验收中', warn: true },
  { key: 'running', label: '运行中' },
  { key: 'idle', label: '空闲' },
  { key: 'done', label: '已完成' },
];

/** 已完成 = 归档:默认展示最近条数,更早的折叠 */
const DONE_RECENT = 5;
/** 空闲 = 停车场:同样紧凑折叠,把注意力让给验收中 */
const IDLE_RECENT = 3;
/** 收纳列(紧凑卡 + 折叠):与验收中/进行态的完整卡区分开 */
const STOWED: SessionState[] = ['idle', 'done'];
const recentOf = (key: SessionState) => (key === 'done' ? DONE_RECENT : IDLE_RECENT);

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

/** 归档拖拽的落点标识:只有「已完成」列接受拖入(单向归档) */
const DONE_DROP_ID = 'col-done';

interface CardProps {
  s: AgentSession;
  sel: boolean;
  /** 拖拽可用性:运行中/等待输入的卡不可拖(那是真实进行态),移动端整体关闭 */
  drag: boolean;
  onOpen: () => void;
  onClose: () => void;
  onUnarchive: () => void;
  onReply: () => void;
  /** 验收中的处置:挂起 → 空闲停车场,归档 → 已完成 */
  onSuspend: () => void;
  onArchive: () => void;
  /** 空闲列里被挂起的卡:撤销挂起,回验收中 */
  onUnsuspend: () => void;
}

/** 关闭按钮:悬停/键盘选中才现身 */
function XClose({ s, onClose }: { s: AgentSession; onClose: () => void }) {
  if (s.readonly) return null;
  return (
    <button
      className="x-close"
      title="关闭会话(Ctrl+X)"
      aria-label={`关闭会话 ${s.name}`}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      ×
    </button>
  );
}

/** 卡片的拖拽外壳:pointer 需移动 6px 才判定为拖拽,单击照常打开回放 */
function useCardDrag(s: AgentSession, enabled: boolean) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: s.sessionId,
    disabled: !enabled,
  });
  return {
    ref: setNodeRef,
    dragProps: enabled ? { ...attributes, ...listeners } : {},
    style: transform
      ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30 }
      : undefined,
    isDragging,
  };
}

/** 已完成 = 归档:两行紧凑卡(标题 / 项目+时间),概要在悬停提示与回放页 */
function CompactCard({ s, sel, drag, onOpen, onClose, onUnarchive, onUnsuspend }: CardProps) {
  const d = useCardDrag(s, drag);
  return (
    <div
      ref={d.ref}
      style={d.style}
      {...d.dragProps}
      className={`scard compact ${sel ? 'kb-sel' : ''} ${d.isDragging ? 'dragging' : ''}`}
      role="button"
      tabIndex={0}
      title={`${s.name}${s.detail ? ' — ' + s.detail : ''}`}
      onClick={() => onOpen()}
    >
      <div className="top">
        {isUnread(s) && <span className="u-dot" />}
        <span className="title">{s.name}</span>
        {isUnread(s) && <span className="tag t-unread">待验收</span>}
        {s.suspended && <span className="tag t-susp">已挂起</span>}
        {s.archived && (
          <button
            className="x-close unarchive"
            title="撤销归档,卡片回到原状态列"
            aria-label={`撤销归档 ${s.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onUnarchive();
            }}
          >
            ↩
          </button>
        )}
        {s.suspended && (
          <button
            className="x-close unarchive"
            title="撤销挂起,卡片回到验收中"
            aria-label={`撤销挂起 ${s.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onUnsuspend();
            }}
          >
            ↩
          </button>
        )}
        <XClose s={s} onClose={onClose} />
      </div>
      <div className="cwd">
        <ProjChip name={s.project} path={s.cwd} />
        <span className="ctime">{timeAgo(s.startedAt)}</span>
      </div>
    </div>
  );
}

function FullCard({ s, sel, drag, onOpen, onClose, onReply, onSuspend, onArchive }: CardProps) {
  const d = useCardDrag(s, drag);
  return (
    <div
      ref={d.ref}
      style={d.style}
      {...d.dragProps}
      className={`scard ${sel ? 'kb-sel' : ''} ${d.isDragging ? 'dragging' : ''}`}
      role="button"
      tabIndex={0}
      title={`${s.name}${s.detail ? ' — ' + s.detail : ''}`}
      onClick={() => onOpen()}
    >
      <div className="top">
        {isUnread(s) && <span className="u-dot" />}
        <span className="title">{s.name}</span>
        {isUnread(s) && <span className="tag t-unread">待验收</span>}
        <Tag>{s.source === 'web' ? 'web' : s.kind === 'background' ? '后台' : '终端'}</Tag>
        {s.readonly && <Tag>只读</Tag>}
        <XClose s={s} onClose={onClose} />
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
              onReply();
            }}
          >
            去回复
          </button>
        )}
        {/* 验收中的三条出路:只有显式处置才让卡片离开该列,这是不再堆积的关键 */}
        {s.state === 'review' && (
          <>
            <button
              className="btn btn-sm btn-primary"
              title="下达下一步指令,回到运行中"
              onClick={(e) => {
                e.stopPropagation();
                onReply();
              }}
            >
              继续
            </button>
            <button
              className="btn btn-sm"
              title="暂时不管,移到空闲;会话再有新产出会自动回验收中"
              onClick={(e) => {
                e.stopPropagation();
                onSuspend();
              }}
            >
              挂起
            </button>
            <button
              className="btn btn-sm"
              title="验收通过,归档到已完成"
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
            >
              归档
            </button>
          </>
        )}
        <span className="time">{clock(s.startedAt)} 开始</span>
      </div>
    </div>
  );
}

/** 「已完成」列体:唯一的拖拽落点,拖拽悬停时高亮 */
function DoneDropZone({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: DONE_DROP_ID });
  return (
    <div ref={setNodeRef} className={`col-body ${isOver ? 'drop-over' : ''}`}>
      {children}
    </div>
  );
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
  /** 收纳列(空闲/已完成)的展开状态:两列各自独立折叠 */
  const [openCols, setOpenCols] = useState<Set<SessionState>>(() => new Set());
  const toggleCol = (key: SessionState) =>
    setOpenCols((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<SessionState>('blocked');
  const [mobileDoneOpen, setMobileDoneOpen] = useState(false);
  /** 拖拽归档的乐观集合:后端确认(轮询数据里已进 done)前先让卡片就位,失败则回滚 */
  const [pendingArchive, setPendingArchive] = useState<Set<string>>(() => new Set());

  // 待验收(未读)排列顶:注意力优先(键盘导航与渲染共用同一排序);乐观归档在此就位
  const columns = useMemo(() => {
    if (!data) return undefined;
    const out = { ...data.columns };
    for (const key of Object.keys(out) as SessionState[]) {
      let arr = [...out[key]];
      if (key !== 'done' && pendingArchive.size) {
        const moved = arr.filter((s) => pendingArchive.has(s.sessionId));
        if (moved.length) {
          arr = arr.filter((s) => !pendingArchive.has(s.sessionId));
          out.done = [...out.done, ...moved.map((s) => ({ ...s, state: 'done' as const, archived: true }))];
        }
      }
      out[key] = arr;
    }
    for (const key of Object.keys(out) as SessionState[]) {
      out[key] = [...out[key]].sort((a, b) => Number(isUnread(b)) - Number(isUnread(a)));
    }
    return out;
  }, [data, pendingArchive]);

  // 后端已把某张卡真正归档进 done,撤下对应的乐观标记(避免它永久盖住真实数据)
  useEffect(() => {
    if (!data || pendingArchive.size === 0) return;
    const settled = new Set(data.columns.done.filter((s) => s.archived).map((s) => s.sessionId));
    if (![...pendingArchive].some((id) => settled.has(id))) return;
    setPendingArchive((prev) => new Set([...prev].filter((id) => !settled.has(id))));
  }, [data, pendingArchive]);

  /** 拖到「已完成」= 手动归档:乐观就位 → 落库 → 立刻重取;失败回滚并提示 */
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      if (e.over?.id !== DONE_DROP_ID) return;
      const sessionId = String(e.active.id);
      setPendingArchive((prev) => new Set(prev).add(sessionId));
      void api
        .archiveSession(sessionId)
        .then(() => refresh())
        .catch((err: unknown) => {
          setPendingArchive((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
          });
          toast(err instanceof Error ? err.message : String(err));
        });
    },
    [refresh],
  );

  /** 撤销归档:卡片回归推导态(会话重新活跃时后端也会自动撤销) */
  const unarchive = useCallback(
    async (s: AgentSession) => {
      try {
        await api.unarchiveSession(s.sessionId);
        toast(`已撤销归档 ${s.name}`);
        refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  /** 验收中 →「挂起」:放回空闲停车场;会话再有新产出后端会自动撤销挂起 */
  const suspend = useCallback(
    async (s: AgentSession) => {
      try {
        await api.suspendSession(s.sessionId);
        toast(`已挂起 ${s.name}`);
        refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  /** 撤销挂起:卡片回验收中 */
  const unsuspend = useCallback(
    async (s: AgentSession) => {
      try {
        await api.unsuspendSession(s.sessionId);
        toast(`已回到验收中 ${s.name}`);
        refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  /** 验收中 →「归档」:与拖拽归档同一后端入口,只是从按钮触发 */
  const archive = useCallback(
    async (s: AgentSession) => {
      setPendingArchive((prev) => new Set(prev).add(s.sessionId));
      try {
        await api.archiveSession(s.sessionId);
        toast(`已归档 ${s.name}`);
        refresh();
      } catch (err) {
        setPendingArchive((prev) => {
          const next = new Set(prev);
          next.delete(s.sessionId);
          return next;
        });
        toast(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  // 指针需移动 6px 才判定拖拽,单击照常打开回放;触屏长按 220ms 起拖,不影响滚动
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

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
  const kbRef = useRef({ kbPos, columns, drawerOpen, openCols });
  kbRef.current = { kbPos, columns, drawerOpen, openCols };
  useEffect(() => {
    if (!active) return;
    // 收纳列(空闲/已完成)折叠区里的卡不参与键盘导航
    const cardsIn = (c: number) => {
      const key = COLS[c]!.key;
      const arr = kbRef.current.columns?.[key] ?? [];
      if (STOWED.includes(key) && !kbRef.current.openCols.has(key)) return arr.slice(0, recentOf(key));
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

  // 卡片渲染:桌面(键盘选中态按列/行坐标)与移动端(单列,无键盘选中)共用同一套组件
  const cardProps = (s: AgentSession, sel: boolean, drag: boolean): CardProps => ({
    s,
    sel,
    drag,
    onOpen: () => void openReplay(s.sessionId, s),
    onClose: () => void closeSession(s, refresh),
    onUnarchive: () => void unarchive(s),
    onReply: () => smartOpen(s, (id, sess) => void openReplay(id, sess)),
    onSuspend: () => void suspend(s),
    onArchive: () => void archive(s),
    onUnsuspend: () => void unsuspend(s),
  });

  return (
    <>
      <div className="view-head">
        <h1>会话</h1>
        <span className="spacer" />
      </div>
      <div className="notice">
        <span className="ok" style={data && !data.ok ? { background: 'var(--red)' } : undefined} />
        {data ? (
          isMobile ? (
            <>
              刷新于 {Math.max(0, Math.round((Date.now() - data.refreshedAt) / 1000))} 秒前 · 终端存活的交互会话仅只读展示
            </>
          ) : (
            <>
              经 <span className="mono">claude agents --json --all</span> 刷新于{' '}
              {Math.max(0, Math.round((Date.now() - data.refreshedAt) / 1000))} 秒前 · 终端存活的交互会话仅只读展示 ·{' '}
              <span className="mono">← ↑ ↓ →</span> 选卡,<span className="mono">Space</span> 进入,
              <span className="mono">Ctrl+X</span> 关闭会话,<span className="mono">Esc</span> 关抽屉
            </>
          )
        ) : (
          '加载中…'
        )}
      </div>
      {!isMobile && (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="board">
            {COLS.map((col, ci) => {
              const items = columns?.[col.key] ?? [];
              const isDone = col.key === 'done';
              // 空闲与已完成都是收纳区:紧凑卡 + 折叠,注意力让位给验收中
              const stowed = STOWED.includes(col.key);
              const recent = recentOf(col.key);
              const open = openCols.has(col.key);
              const olderCount = stowed ? Math.max(0, items.length - recent) : 0;
              // 运行中/等待输入是真实进行态,不给拖;验收中的卡可拖去已完成归档
              const card = (s: AgentSession, ri: number) => {
                const p = cardProps(s, kbPos?.c === ci && kbPos?.r === ri, col.key === 'review');
                return stowed ? <CompactCard key={s.id} {...p} /> : <FullCard key={s.id} {...p} />;
              };
              const body = (
                <>
                  {items.slice(0, stowed ? recent : undefined).map((s, ri) => card(s, ri))}
                  {olderCount > 0 && (
                    <button className="col-more" onClick={() => toggleCol(col.key)}>
                      {open ? '收起 ▴' : `更早的 ${olderCount} 条 ▾`}
                    </button>
                  )}
                  {stowed && open && items.slice(recent).map((s, i) => card(s, recent + i))}
                  {items.length === 0 && (
                    <div className="empty" style={{ padding: '24px 12px' }}>
                      <p>
                        {isDone
                          ? '暂无 · 可把验收中的卡片拖到这里归档'
                          : col.key === 'review'
                            ? '暂无 · 跑完的会话会落到这里等你处置'
                            : '暂无'}
                      </p>
                    </div>
                  )}
                </>
              );
              return (
                <div key={col.key}>
                  <div className="col-head">
                    <Pill state={col.key} />
                    <span className="n">{items.length}</span>
                  </div>
                  {isDone ? <DoneDropZone>{body}</DoneDropZone> : <div className="col-body">{body}</div>}
                </div>
              );
            })}
          </div>
        </DndContext>
      )}

      {/* 移动端:状态 tab(需要你优先)+ 单列卡片流,取代桌面 4×272px 横向滚动看板 */}
      {isMobile && (
        // DndContext 仅为满足卡片组件的 useDraggable(移动端 drag 全关),不设落点
        <DndContext sensors={sensors}>
        <div className="board-mobile">
          <div className="seg-scroll">
            <div className="seg">
              {MOBILE_TABS.map((t) => {
                const n = columns?.[t.key]?.length ?? 0;
                return (
                  <button key={t.key} className={mobileTab === t.key ? 'active' : ''} onClick={() => { setMobileTab(t.key); setMobileDoneOpen(false); }}>
                    {t.warn && mobileTab !== t.key && n > 0 && <span className="warn-dot" />}
                    {t.label}<span className="n mono">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {(() => {
            const items = columns?.[mobileTab] ?? [];
            const stowed = STOWED.includes(mobileTab);
            const recent = recentOf(mobileTab);
            const olderCount = stowed ? Math.max(0, items.length - recent) : 0;
            // 移动端是 tab 切换而非并排看板,没有可拖的落点,处置全走卡片自身入口
            const card = (s: AgentSession) => {
              const p = cardProps(s, false, false);
              return stowed ? <CompactCard key={s.id} {...p} /> : <FullCard key={s.id} {...p} />;
            };
            if (items.length === 0) return <div className="empty" style={{ padding: '32px 12px' }}><p>这个状态下暂无会话。</p></div>;
            return (
              <>
                {items.slice(0, stowed ? recent : undefined).map((s) => card(s))}
                {olderCount > 0 && (
                  <button className="col-more" onClick={() => setMobileDoneOpen(!mobileDoneOpen)}>
                    {mobileDoneOpen ? '收起 ▴' : `更早的 ${olderCount} 条 ▾`}
                  </button>
                )}
                {stowed && mobileDoneOpen && items.slice(recent).map((s) => card(s))}
              </>
            );
          })()}
        </div>
        </DndContext>
      )}

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
                {replayFor.state === 'review' ? '继续' : '续接此会话(--resume)'}
              </button>
            )}
            {/* 看完回放当场就能处置,不必关抽屉再回卡片找按钮 */}
            {replayFor?.state === 'review' && (
              <>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setDrawerOpen(false);
                    void suspend(replayFor);
                  }}
                >
                  挂起
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setDrawerOpen(false);
                    void archive(replayFor);
                  }}
                >
                  归档
                </button>
              </>
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
                  <Md>{ev.text}</Md>
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
