/**
 * 待办:临时想法的收集箱。核心闭环 = 随手记 → 有空回顾 → 一键开工进派发会话。
 *
 * 与「总结」的关系:总结记的是做完的事(只读扫 ~/.claude/worklog),待办记的是还没做的事
 * (自有 SQLite)。两者一前一后夹住一次任务的生命周期。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { Todo } from '@/api/types';
import { usePoll, useIsMobile, isTypingTarget } from '@/lib/hooks';
import { setDispatchIntent } from '@/lib/dispatch';
import { timeAgo } from '@/lib/utils';
import { confirmBox, Empty, ProjChip, toast } from '@/components/shared';
import { WdPalette } from '@/components/WdPalette';
import { Input } from '@/components/ui/input';

type Filter = 'all' | 'open' | 'doing' | 'done';

const STATUS: Record<Todo['status'], { cls: string; label: string; dot: boolean }> = {
  open: { cls: 'pill-idle', label: '待办', dot: false },
  doing: { cls: 'pill-run', label: '进行中', dot: true },
  done: { cls: 'pill-done', label: '已完成', dot: false },
};

/** 分组标题:今天/昨天/具体日期(与总结模块的日期分组同一词汇) */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 待办变更广播:⌘J 浮层挂在 App 层、待办列表与仪表盘卡各自轮询,
 * 不广播的话在待办页按 ⌘J 记一条,要等到下次轮询(最长 30s)才看得见自己刚记的东西。
 */
const TODOS_CHANGED = 'xuanji:todos-changed';
export function notifyTodosChanged() {
  window.dispatchEvent(new CustomEvent(TODOS_CHANGED));
}
export function useTodosChanged(refresh: () => void) {
  useEffect(() => {
    window.addEventListener(TODOS_CHANGED, refresh);
    return () => window.removeEventListener(TODOS_CHANGED, refresh);
  }, [refresh]);
}

/** 停留超过这个天数的未完成待办算「积压」:收集箱最该被看见的信号 */
const STALE_DAYS = 3;
export function isStale(t: Todo): boolean {
  return t.status !== 'done' && Date.now() - t.createdAt > STALE_DAYS * 86_400_000;
}

/**
 * 开工:带着项目 cwd 与待办内容跳派发页。内容预填进输入框但不自动发送——
 * 待办往往只是半句话想法,直接发质量不高,留一步给人补充。
 * 发送后由派发页把 sessionId 回填到这条待办(见 Dispatch 里的 todoId 处理)。
 */
export function startTodo(t: Todo) {
  setDispatchIntent({ cwd: t.cwd ?? undefined, prefill: t.title, todoId: t.id });
  location.hash = 'dispatch';
}

export function Todos() {
  const [filter, setFilter] = useState<Filter>('all');
  const [draft, setDraft] = useState('');
  const [draftCwd, setDraftCwd] = useState<string | null>(null);
  const [wdOpen, setWdOpen] = useState(false);
  const draftRef = useRef<HTMLInputElement>(null);
  /**
   * 项目选择器关闭后把焦点还给速记框:这一行的主交互是「打字→回车」,焦点落回 body 整行就废了
   * (选完项目按回车什么都不发生 —— 2026-07-31 实测)。WdPalette 卸载前还会轮询抢焦点,
   * 单次 focus 会被它抢回去,故沿用同款轮询重试(50ms×10 上限 ~0.5s)。
   */
  const focusDraft = () => {
    let tries = 0;
    const timer = setInterval(() => {
      draftRef.current?.focus();
      if (document.activeElement === draftRef.current || ++tries > 10) clearInterval(timer);
    }, 50);
  };
  const [busy, setBusy] = useState(false);
  const isMobile = useIsMobile();
  const { data, refresh } = usePoll(api.todos, 30_000);
  const { data: projectsData } = usePoll(api.projects, 60_000);
  useTodosChanged(refresh);

  const todos = useMemo(() => data?.todos ?? [], [data]);
  const rows = useMemo(
    () => (filter === 'all' ? todos : todos.filter((t) => t.status === filter)),
    [todos, filter],
  );

  /** 按创建日分组(列表已按 id 倒序 = 时间倒序,保序聚合即可) */
  const groups = useMemo(() => {
    const m = new Map<string, Todo[]>();
    for (const t of rows) {
      const k = dayLabel(t.createdAt);
      const arr = m.get(k);
      if (arr) arr.push(t);
      else m.set(k, [t]);
    }
    return [...m.entries()];
  }, [rows]);

  /**
   * 键盘选中按 id 记(不按下标):轮询 30s 刷一次,新记的待办插在最前会把下标整体顶掉,
   * 按 id 记则选中始终跟着同一条走。选中项被筛掉/删掉时回落到第一条。
   */
  const [kbId, setKbId] = useState<number | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  const undone = todos.filter((t) => t.status !== 'done').length;
  const stale = todos.filter(isStale).length;
  const cwdOptions = useMemo(() => (projectsData?.projects ?? []).map((p) => p.path), [projectsData]);
  const shortOf = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

  const add = async () => {
    // 与 TodoPalette 同理:DOM 值为准,防 WKWebView 输入法上屏后 state 落后
    const t = (draftRef.current?.value ?? draft).trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.createTodo(t, draftCwd);
      setDraft('');
      if (draftRef.current) draftRef.current.value = ''; // state 若本就为空,受控 value 不会触发 DOM 清空
      notifyTodosChanged(); // 本页与仪表盘卡同时刷新
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  /** 勾选 = 在「完成 / 未完成」间切换(误勾可直接点回来,不需要撤销入口) */
  const toggleDone = async (t: Todo) => {
    try {
      await api.updateTodo(t.id, { status: t.status === 'done' ? 'open' : 'done' });
      notifyTodosChanged(); // 本页与仪表盘卡同时刷新
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新失败');
    }
  };

  const remove = async (t: Todo) => {
    if (!(await confirmBox(`删除待办「${t.title}」?`))) return;
    try {
      await api.deleteTodo(t.id);
      notifyTodosChanged(); // 本页与仪表盘卡同时刷新
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败');
    }
  };

  /** 就地改标题:空标题视为放弃(不落库,也不当删除处理),内容没变则直接收起不打接口 */
  const saveEdit = async (t: Todo) => {
    const next = (editRef.current?.value ?? '').trim();
    setEditId(null);
    if (!next || next === t.title) return;
    try {
      await api.updateTodo(t.id, { title: next });
      notifyTodosChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : '重命名失败');
    }
  };

  /**
   * 键盘导航:↑↓ 选中,Space 勾选,Enter 开工,E 改标题,⌫ 删除。
   * 编辑态与项目选择器打开时整体让出按键(否则打字会被当快捷键吃掉)。
   */
  const kbRef = useRef({ rows, kbId, editId, wdOpen });
  kbRef.current = { rows, kbId, editId, wdOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { rows: list, kbId: cur, editId: ed, wdOpen: wd } = kbRef.current;
      if (ed !== null || wd || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (list.length === 0) return;
      const key = e.code === 'Space' ? ' ' : e.key;
      const idx = list.findIndex((t) => t.id === cur);
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        // 未选中时首按落在第一条;选中项已被筛掉(idx=-1)同样回到第一条
        const next = idx === -1 ? 0 : Math.min(list.length - 1, Math.max(0, idx + (key === 'ArrowDown' ? 1 : -1)));
        setKbId(list[next]!.id);
        return;
      }
      if (idx === -1) return;
      const t = list[idx]!;
      if (key === ' ') {
        e.preventDefault();
        void toggleDone(t);
      } else if (key === 'Enter') {
        e.preventDefault();
        if (t.status !== 'done') startTodo(t);
      } else if (key === 'e' || key === 'E') {
        e.preventDefault();
        setEditId(t.id);
      } else if (key === 'Backspace' || key === 'Delete') {
        e.preventDefault();
        void remove(t);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 选中项滚进视野;进入编辑态时把光标放到行内输入框并全选(改标题多为整句重写)
  useEffect(() => {
    if (kbId !== null) rowRefs.current.get(kbId)?.scrollIntoView({ block: 'nearest' });
  }, [kbId]);
  useEffect(() => {
    if (editId !== null) editRef.current?.select();
  }, [editId]);

  return (
    <>
      <div className="view-head">
        <h1>待办</h1>
        <span className="sub">
          {undone} 条未完成
          {stale > 0 && <span style={{ color: 'var(--amber)' }}> · {stale} 条超过 {STALE_DAYS} 天</span>}
        </span>
        <span className="spacer" />
        <div className="filter-tabs">
          {([['all', '全部'], ['open', '待办'], ['doing', '进行中'], ['done', '已完成']] as [Filter, string][]).map(
            ([f, label]) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {label}
              </button>
            ),
          )}
        </div>
      </div>

      {/* 速记行:本页的第一动作,回车即存 */}
      <div className="td-capture">
        <span className="plus" aria-hidden="true">＋</span>
        <Input
          ref={draftRef}
          placeholder="记一条待办…(回车保存)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add();
          }}
        />
        <button className="td-proj-pick" onClick={() => setWdOpen(true)} title="指定项目(开工时带入的工作目录)">
          {draftCwd ? shortOf(draftCwd) : '未指定'} ▾
        </button>
        {!isMobile && <span className="hint mono">↩ 保存</span>}
      </div>

      <div className="notice">
        <span className="ok" />
        自有数据(SQLite),与 <span className="mono">~/.claude</span> 无关 · 任意页面按{' '}
        <span className="mono">⌘J</span> 速记 · 也可从 Raycast 用全局热键记入(见{' '}
        <span className="mono">wiki/tech/todo-raycast.md</span>)
        {!isMobile && (
          <>
            {' '}
            · <span className="mono">↑ ↓</span> 选中,<span className="mono">Space</span> 勾选,
            <span className="mono">Enter</span> 开工,<span className="mono">E</span> 改标题,
            <span className="mono">⌫</span> 删除
          </>
        )}
      </div>

      {rows.length === 0 ? (
        <Empty>
          <p>{todos.length === 0 ? '还没有待办。' : '这个筛选下没有待办。'}</p>
          <p style={{ color: 'var(--faint)' }}>临时想法随手记一条,有空时点「开工」直接进派发会话。</p>
        </Empty>
      ) : (
        <div className="panel">
          {groups.map(([day, list], gi) => (
            <div key={day} className="td-group" style={gi > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}>
              <h2>{day}</h2>
              {list.map((t) => (
                <div
                  key={t.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(t.id, el);
                    else rowRefs.current.delete(t.id);
                  }}
                  className={`td-item${t.status === 'done' ? ' done' : ''}${kbId === t.id ? ' kb-sel' : ''}`}
                  onClick={() => setKbId(t.id)}
                >
                  <button
                    className="chk"
                    onClick={() => void toggleDone(t)}
                    aria-label={t.status === 'done' ? '标记为未完成' : '标记完成'}
                    title={t.status === 'done' ? '标记为未完成' : '标记完成'}
                  >
                    ✓
                  </button>
                  {editId === t.id ? (
                    <Input
                      ref={editRef}
                      className="td-edit-input"
                      defaultValue={t.title}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === 'Enter') void saveEdit(t);
                        else if (e.key === 'Escape') setEditId(null);
                        e.stopPropagation();
                      }}
                      onBlur={() => void saveEdit(t)}
                    />
                  ) : (
                    <span className="title" title={t.title} onDoubleClick={() => setEditId(t.id)}>
                      {t.title}
                    </span>
                  )}
                  {t.project ? <ProjChip name={t.project} path={t.cwd ?? undefined} /> : <span className="td-noproj">未指定</span>}
                  <span className="age mono" title={new Date(t.createdAt).toLocaleString('zh-CN')}>
                    {timeAgo(t.createdAt)}
                  </span>
                  <span className={`pill ${STATUS[t.status].cls}`}>
                    {STATUS[t.status].dot && <span className="dot" />}
                    {STATUS[t.status].label}
                  </span>
                  {t.status !== 'done' && (
                    <button className="td-go" onClick={() => startTodo(t)}>
                      {t.status === 'doing' ? '继续 ▶' : '开工 ▶'}
                    </button>
                  )}
                  <button className="td-del" onClick={() => setEditId(t.id)} aria-label="编辑" title="编辑标题(E)">
                    ✎
                  </button>
                  <button className="td-del" onClick={() => void remove(t)} aria-label="删除" title="删除">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {wdOpen && (
        <WdPalette
          value={draftCwd ?? ''}
          options={cwdOptions}
          title="指定项目"
          placeholder="模糊搜索项目…(如 xj)"
          emptyNoun="项目"
          onPick={(p) => {
            setDraftCwd(p);
            setWdOpen(false);
            focusDraft(); // 选完项目焦点必须回速记框,否则「↩ 保存」按下去没人接(焦点在 body)
          }}
          onClose={() => {
            setWdOpen(false);
            focusDraft();
          }}
        />
      )}
    </>
  );
}
