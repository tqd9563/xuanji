import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { api } from '@/api/client';
import type { AgentSession, Replay, SessionState } from '@/api/types';
import { usePoll, isTypingTarget, useIsMobile } from '@/lib/hooks';
import { setDispatchIntent } from '@/lib/dispatch';
import { clock, daySeparator, isUnread, markSeen, timeAgo } from '@/lib/utils';
import { CompactionCard, Drawer, Empty, Md, MsgTime, Pill, ProjChip, Tag, ToolCard, confirmBox, toast } from '@/components/shared';
import { FindBar, useFindInPage } from '@/components/FindBar';

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

/**
 * 四列生命周期:做 → 验 → 停 → 档(列序 = 注意力流,收纳区靠右)。
 *
 * 「等待输入」不独占一列——它不是生命周期的一段,而是运行中会话的瞬时子状态
 * (会话还活着,只是停下来问你一句),低频却常年占 1/5 宽度。并入「进行中」后靠
 * 置顶 + 左侧琥珀立柱保持显眼,列头另给「n 等你」计数,注意力信号一个不少。
 * 后端 blocked 状态本身保留,这里只是不再为它单独开列。
 */
const COLS: { key: SessionState; label: string; states: SessionState[] }[] = [
  { key: 'running', label: '进行中', states: ['running', 'blocked'] },
  { key: 'review', label: '验收中', states: ['review'] },
  { key: 'idle', label: '空闲', states: ['idle'] },
  { key: 'done', label: '已完成', states: ['done'] },
];

/** 移动端状态 tab 顺序与文案:「需要你」优先(与 DESIGN.md 移动端章节同源),
 *  取代桌面横向滚动看板——重新组织信息架构而非缩放同一个网格。
 *  这里「需要你」仍与「运行中」分列两个 tab:桌面合并是为省列宽,tab 不占宽度,
 *  而移动端最主要的用法恰恰是「有没有事等我处理」,拆开更直达。 */
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

/** 拖拽落点:验收中的卡可拖进「已完成」(归档)或「空闲」(挂起),与卡上两个按钮同义 */
const DONE_DROP_ID = 'col-done';
const IDLE_DROP_ID = 'col-idle';
/** 可拖的源列:验收中(→ 空闲挂起 / 已完成归档)与空闲(→ 已完成归档) */
const DRAGGABLE_COLS: SessionState[] = ['review', 'idle'];

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
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: s.sessionId,
    disabled: !enabled,
  });
  // 卡内按钮(归档/挂起/继续/关闭)上的按压不进拖拽通道:onClick 的 stopPropagation 拦不住
  // pointerdown,按钮上手抖 6px 就会被判成拖拽,click 随即被吞——表现为「首次点击失效,
  // 卡片黏住鼠标」(2026-08-05 验收中卡片实测)。
  const guard =
    <E extends React.SyntheticEvent>(key: 'onPointerDown' | 'onTouchStart') =>
    (e: E) => {
      if ((e.target as HTMLElement).closest('button')) return;
      (listeners?.[key] as ((ev: E) => void) | undefined)?.(e);
    };
  return {
    ref: setNodeRef,
    dragProps: enabled
      ? {
          ...attributes,
          ...listeners,
          onPointerDown: guard<React.PointerEvent>('onPointerDown'),
          onTouchStart: guard<React.TouchEvent>('onTouchStart'),
        }
      : {},
    // 跟手的那张由 DragOverlay 画(渲染在 body 层,不被列的 overflow 裁掉、也不被邻列盖住);
    // 原位卡只留半透明占位,所以这里不再给它上 transform。
    style: undefined,
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

/** blk = 左侧琥珀立柱,在合并列里标出「它在等你回话」;与 kb-sel 走不同视觉通道,可叠加显示 */
function FullCard({ s, sel, drag, onOpen, onClose, onReply, onSuspend, onArchive }: CardProps) {
  const d = useCardDrag(s, drag);
  return (
    <div
      ref={d.ref}
      style={d.style}
      {...d.dragProps}
      className={`scard ${s.state === 'blocked' ? 'blk' : ''} ${sel ? 'kb-sel' : ''} ${d.isDragging ? 'dragging' : ''}`}
      role="button"
      tabIndex={0}
      title={`${s.name}${s.detail ? ' — ' + s.detail : ''}`}
      onClick={() => onOpen()}
    >
      <div className="top">
        {isUnread(s) && <span className="u-dot" />}
        <span className="title">{s.name}</span>
        {isUnread(s) && <span className="tag t-unread">待验收</span>}
        {s.state === 'blocked' && <span className="tag t-unread">等输入</span>}
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

/**
 * 验收中的中密度卡:标题 / 项目+id / 一行摘要 / 三个处置按钮 —— 四行。
 *
 * 相对全尺寸卡砍掉的都是验收时用不到的:来源标(点开回放都有)、needs 区(验收态没有
 * needs)、多行摘要压成单行截断(全文在悬停提示与回放里)。摘要与按钮都不能砍——
 * 前者是「要不要点开细看」的依据,后者是这列存在的意义。
 * 该列刻意不折叠:列的长度就是积压量的信号,收起来等于回到「看不见就忘」,
 * 所以只能从单卡高度上要空间。
 */
function MidCard({ s, sel, drag, onOpen, onClose, onReply, onSuspend, onArchive }: CardProps) {
  const d = useCardDrag(s, drag);
  return (
    <div
      ref={d.ref}
      style={d.style}
      {...d.dragProps}
      className={`scard mid ${sel ? 'kb-sel' : ''} ${d.isDragging ? 'dragging' : ''}`}
      role="button"
      tabIndex={0}
      title={`${s.name}${s.detail ? ' — ' + s.detail : ''}`}
      onClick={() => onOpen()}
    >
      <div className="top">
        {isUnread(s) && <span className="u-dot" />}
        <span className="title">{s.name}</span>
        {isUnread(s) && <span className="tag t-unread">待验收</span>}
        <XClose s={s} onClose={onClose} />
      </div>
      <div className="cwd">
        <ProjChip name={s.project} path={s.cwd} />
        <span className="sid">{s.id}</span>
      </div>
      {s.detail && <div className="detail one">{s.detail}</div>}
      <div className="foot">
        <button
          className="btn btn-sm btn-primary"
          title="下达下一步指令,回到进行中"
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
        <span className="time">{clock(s.startedAt)}</span>
      </div>
    </div>
  );
}

/** 拖拽落点列体(已完成 = 归档,空闲 = 挂起),悬停时高亮 */
function ColDropZone({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
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
  // 会话内查找(⌘F):作用域是回放抽屉的滚动体,只在抽屉打开时接管快捷键
  const drawerBodyRef = useRef<HTMLDivElement>(null);
  const find = useFindInPage(drawerBodyRef, drawerOpen);
  // 跨天分隔线:与事件列表等长,replayDaySeps[i] 非空表示第 i 条事件之前要插一条日期。
  // 只有对话消息(user/assistant)参与:工具卡/raw 本就无时间,而 compact 虽带 ts,却在
  // 下面的 map 里提前 return 成卡片、渲染不到分隔线——让它参与游标会把那一天的日期头
  // 算在一个不渲染的位置上,整天的分界凭空消失(2026-08-19 用真实跨天会话仿真时暴露)。
  const replayDaySeps = useMemo(() => {
    let prev: string | undefined;
    return (replay?.events ?? []).map((ev) => {
      const ts = ev.kind === 'user' || ev.kind === 'assistant' ? ev.ts : undefined;
      if (ts == null) return null;
      const sep = daySeparator(prev, ts);
      prev = ts;
      return sep;
    });
  }, [replay]);
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
  /** 拖拽挂起的乐观集合:同上,后端确认前先把卡挪进空闲 */
  const [pendingSuspend, setPendingSuspend] = useState<Set<string>>(() => new Set());
  /** 正在拖的卡:交给 DragOverlay 画,免受列 overflow 裁剪与邻列遮挡 */
  const [dragId, setDragId] = useState<string | null>(null);

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
      if (key === 'review' && pendingSuspend.size) {
        const moved = arr.filter((s) => pendingSuspend.has(s.sessionId));
        if (moved.length) {
          arr = arr.filter((s) => !pendingSuspend.has(s.sessionId));
          out.idle = [...out.idle, ...moved.map((s) => ({ ...s, state: 'idle' as const, suspended: true }))];
        }
      }
      out[key] = arr;
    }
    for (const key of Object.keys(out) as SessionState[]) {
      out[key] = [...out[key]].sort((a, b) => Number(isUnread(b)) - Number(isUnread(a)));
    }
    return out;
  }, [data, pendingArchive]);

  /**
   * 桌面列 → 卡片列表。合并列把多个状态拼起来,等你回话的(blocked)排最前——
   * 它是这列里唯一需要你动手的。其余列沿用 columns 里已按未读排好的顺序。
   * 渲染与键盘导航共用此函数,避免两处排序漂移导致「看到的」与「选中的」错位。
   */
  const itemsOf = useCallback(
    (col: (typeof COLS)[number]): AgentSession[] => {
      if (!columns) return [];
      const arr = col.states.flatMap((st) => columns[st] ?? []);
      if (col.key !== 'running') return arr;
      return [...arr].sort((a, b) => Number(b.state === 'blocked') - Number(a.state === 'blocked'));
    },
    [columns],
  );

  // 后端已把某张卡真正归档进 done,撤下对应的乐观标记(避免它永久盖住真实数据)
  useEffect(() => {
    if (!data || pendingArchive.size === 0) return;
    const settled = new Set(data.columns.done.filter((s) => s.archived).map((s) => s.sessionId));
    if (![...pendingArchive].some((id) => settled.has(id))) return;
    setPendingArchive((prev) => new Set([...prev].filter((id) => !settled.has(id))));
  }, [data, pendingArchive]);

  // 后端已确认挂起,撤下乐观标记
  useEffect(() => {
    if (!data || pendingSuspend.size === 0) return;
    const settled = new Set(data.columns.idle.filter((s) => s.suspended).map((s) => s.sessionId));
    if (![...pendingSuspend].some((id) => settled.has(id))) return;
    setPendingSuspend((prev) => new Set([...prev].filter((id) => !settled.has(id))));
  }, [data, pendingSuspend]);

  /**
   * 拖到「已完成」= 归档,拖到「空闲」= 挂起:与卡上同名按钮同一后端入口。
   * 乐观就位 → 落库 → 立刻重取;失败回滚并提示。
   */
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setDragId(null);
      const over = e.over?.id;
      if (over !== DONE_DROP_ID && over !== IDLE_DROP_ID) return;
      const sessionId = String(e.active.id);
      const toIdle = over === IDLE_DROP_ID;
      // 空闲列的卡拖回空闲列 = 没动:不发请求,免得对已挂起的卡重复挂起
      if (toIdle && (columns?.idle ?? []).some((s) => s.sessionId === sessionId)) return;
      const setPending = toIdle ? setPendingSuspend : setPendingArchive;
      setPending((prev) => new Set(prev).add(sessionId));
      void (toIdle ? api.suspendSession(sessionId) : api.archiveSession(sessionId))
        .then(() => refresh())
        .catch((err: unknown) => {
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
          });
          toast(err instanceof Error ? err.message : String(err));
        });
    },
    [refresh, columns],
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
  const kbRef = useRef({ kbPos, itemsOf, drawerOpen, openCols });
  kbRef.current = { kbPos, itemsOf, drawerOpen, openCols };
  useEffect(() => {
    if (!active) return;
    // 与渲染共用 itemsOf(合并列同序);收纳列折叠区里的卡不参与键盘导航
    const cardsIn = (c: number) => {
      const col = COLS[c]!;
      const arr = kbRef.current.itemsOf(col);
      if (STOWED.includes(col.key) && !kbRef.current.openCols.has(col.key)) {
        return arr.slice(0, recentOf(col.key));
      }
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
      // 空格按物理键位(e.code)识别:中文输入法全角空格等场景下 e.key 不是 ' ',
      // 表现为「空格进不去、回车可以」(2026-08-11 反馈)
      const key = e.code === 'Space' ? ' ' : e.key;
      if (![' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
      e.preventDefault();
      let pos = kbRef.current.kbPos;
      if (!pos) {
        // 无选中时首按:方向键只落位选中;Space/Enter 直接进入首卡——
        // 「按空格没反应(其实只是选中了),换回车就行(第二下)」的错觉即来源于旧的两段式
        const c = COLS.findIndex((_, i) => cardsIn(i).length > 0);
        if (c === -1) return;
        setKbPos({ c, r: 0 });
        if (key === ' ' || key === 'Enter') {
          const s = cardsIn(c)[0];
          if (s) smartOpen(s, (id, sess) => void openReplay(id, sess));
        }
        return;
      }
      pos = { ...pos };
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const dir = key === 'ArrowLeft' ? -1 : 1;
        let c = pos.c;
        do {
          c += dir;
        } while (c >= 0 && c < COLS.length && cardsIn(c).length === 0);
        if (c < 0 || c >= COLS.length || cardsIn(c).length === 0) return;
        pos = { c, r: Math.min(pos.r, cardsIn(c).length - 1) };
      } else if (key === 'ArrowUp') {
        pos.r = Math.max(0, pos.r - 1);
      } else if (key === 'ArrowDown') {
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
        <DndContext
          sensors={sensors}
          onDragStart={(e: DragStartEvent) => setDragId(String(e.active.id))}
          onDragCancel={() => setDragId(null)}
          onDragEnd={onDragEnd}
        >
          <div className="board">
            {COLS.map((col, ci) => {
              const items = itemsOf(col);
              const isDone = col.key === 'done';
              // 空闲与已完成都是收纳区:紧凑卡 + 折叠,注意力让位给验收中
              const stowed = STOWED.includes(col.key);
              const recent = recentOf(col.key);
              const open = openCols.has(col.key);
              const olderCount = stowed ? Math.max(0, items.length - recent) : 0;
              // 合并列里等你回话的张数:列头单独标,不必逐张扫也知道有几件事卡着
              const waiting =
                col.key === 'running' ? items.filter((s) => s.state === 'blocked').length : 0;
              // 运行中/等待输入是真实进行态,不给拖;验收中(→空闲/已完成)与空闲(→已完成)可拖
              const card = (s: AgentSession, ri: number) => {
                const p = cardProps(s, kbPos?.c === ci && kbPos?.r === ri, DRAGGABLE_COLS.includes(col.key));
                // 点击卡片同步键盘选中位:此后 Space/Enter 从鼠标停留处继续,而非跳回首卡
                const baseOpen = p.onOpen;
                p.onOpen = () => {
                  setKbPos({ c: ci, r: ri });
                  baseOpen();
                };
                if (stowed) return <CompactCard key={s.id} {...p} />;
                // 验收中用中密度卡:压低单卡高度,让列长如实反映积压量(该列刻意不折叠)
                return col.key === 'review' ? <MidCard key={s.id} {...p} /> : <FullCard key={s.id} {...p} />;
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
                          ? '暂无 · 可把验收中/空闲的卡片拖到这里归档'
                          : col.key === 'review'
                            ? '暂无 · 跑完的会话会落到这里等你处置'
                            : col.key === 'idle'
                              ? '暂无 · 可把验收中的卡片拖到这里挂起'
                              : '暂无'}
                      </p>
                    </div>
                  )}
                </>
              );
              return (
                <div key={col.key}>
                  <div className="col-head">
                    <Pill state={col.key} label={col.label} />
                    <span className="n">{items.length}</span>
                    {waiting > 0 && (
                      <span className="n" style={{ color: 'var(--amber)' }}>
                        · {waiting} 等你
                      </span>
                    )}
                  </div>
                  {isDone || col.key === 'idle' ? (
                    <ColDropZone id={isDone ? DONE_DROP_ID : IDLE_DROP_ID}>{body}</ColDropZone>
                  ) : (
                    <div className="col-body">{body}</div>
                  )}
                </div>
              );
            })}
          </div>
          {/* 跟手的那张:渲染在 body 层,不被列的 overflow 裁掉,也不被右侧列盖住 */}
          <DragOverlay dropAnimation={null} className="drag-ghost">
            {(() => {
              if (!dragId || !columns) return null;
              const s = DRAGGABLE_COLS.flatMap((k) => columns[k] ?? []).find((x) => x.sessionId === dragId);
              if (!s) return null;
              const p = cardProps(s, false, false);
              // 卡型跟随源列:验收中是中密度卡,空闲是紧凑卡——浮层与原位形状一致才不跳
              return s.state === 'idle' ? <CompactCard {...p} /> : <MidCard {...p} />;
            })()}
          </DragOverlay>
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
        bodyRef={drawerBodyRef}
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
        <FindBar scopeRef={drawerBodyRef} state={find} placeholder="在本次回放中查找" />
        {!replay && <Empty><p>回放加载中…</p></Empty>}
        {replay?.events.map((ev, i) => {
          if (ev.kind === 'tool') return <ToolCard key={i} {...ev} />;
          if (ev.kind === 'compact') return <CompactionCard key={i} {...ev} />;
          if (ev.kind === 'raw')
            return (
              <div className="raw-event" key={i}>
                <div className="note">⚠ 未知事件类型「{ev.type}」,已按原始文本降级展示(adapter 兜底)</div>
                {ev.json}
              </div>
            );
          return (
            <Fragment key={i}>
              {replayDaySeps[i] && <div className="day-sep">{replayDaySeps[i]}</div>}
              <div className="replay-msg">
                <div className={`who ${ev.kind === 'user' ? 'u' : ''}`}>
                  {ev.kind === 'user' ? '你' : 'Claude'}
                  <MsgTime ts={ev.ts} />
                </div>
                {ev.kind === 'assistant' ? (
                  <div className="body md">
                    <Md>{ev.text}</Md>
                  </div>
                ) : (
                  <div className="body">{ev.text}</div>
                )}
              </div>
            </Fragment>
          );
        })}
        {replay && replay.events.length === 0 && <Empty><p>此会话没有可回放的事件。</p></Empty>}
      </Drawer>
    </>
  );
}
