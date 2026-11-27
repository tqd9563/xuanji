import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { Memory, TrashedMemory } from '@/api/types';
import { isTypingTarget, useMediaQuery, usePoll } from '@/lib/hooks';
import { formatCombo, matchKey } from '@/lib/keymap';
import { useLocalPrefs } from '@/lib/prefs';
import { cn, projColor } from '@/lib/utils';
import {
  EDIT_TYPES,
  TYPE_FILTERS,
  type TypeFilter,
  countByProject,
  descSnippet,
  hitSegments,
  inboundRefs,
  matchesQuery,
  normalizeMemoryBody,
  orderByFacets,
  projectFacets,
  rehypeMemory,
  shortFile,
} from '@/lib/memories';
import { Drawer, Empty, Md, ProjChip, confirmBox, toast } from '@/components/shared';
import { Input } from '@/components/ui/input';

/**
 * 经验页(获批原型 wiki/design/prototype-memories-layout.html 方案 B「阅读窗格」)。
 * 顶部项目筛选条 + 列表 / 正文双栏:搜到即读,↑↓ 换条不开抽屉;正文栏原地编辑,删除进回收站。
 * 窄屏(≤900px)放不下双栏,正文与编辑退回抽屉。
 */

const TYPE_LABEL: Record<string, string> = {
  user: 'user',
  feedback: 'feedback',
  project: 'project',
  reference: 'reference',
  'cross-project': 'cross-project',
  unknown: '?',
};
/** 筛选条直出的项目数;其余收进下拉(1440 宽下 5 枚胶囊 + 「其余」刚好一行) */
const CHIP_TOP = 5;
const NARROW = '(max-width: 900px)';

interface Draft {
  /** 进入编辑时取的完整详情:脏检查与 rev 都以它为准 */
  base: Memory;
  description: string;
  type: Memory['type'];
  body: string;
  indexHook: string;
  /** 保存时发现文件被别处改过 */
  conflict: boolean;
  saving: boolean;
}
const isDirty = (d: Draft) =>
  d.description !== d.base.description || d.type !== d.base.type || d.body !== d.base.body || d.indexHook !== (d.base.indexHook ?? '');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Hi({ text, q }: { text: string; q: string }) {
  return (
    <>
      {hitSegments(text, q).map((s, i) =>
        s.hit ? (
          <mark className="xjm-hit" key={i}>
            {s.text}
          </mark>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

const TypeTag = ({ type }: { type: Memory['type'] }) => <span className={`type-${type}`}>{TYPE_LABEL[type]}</span>;

export function Memories() {
  const { data, refresh } = usePoll(api.memories, 60_000);
  const trashPoll = usePoll(api.memoryTrash, 60_000);
  const narrow = useMediaQuery(NARROW);
  const findKey = useLocalPrefs().keymap['sessions.find'];

  const [type, setType] = useState<TypeFilter>('all');
  const [project, setProject] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Memory[] | null>(null);
  const [selFile, setSelFile] = useState<string | null>(null);
  const [trashView, setTrashView] = useState(false);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [delAsk, setDelAsk] = useState<Memory | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const editBodyRef = useRef<HTMLTextAreaElement>(null);

  // 写操作后的本地修正:轮询结果可能是写之前就发出的旧响应(sharedFetch 会合流到在途请求),
  // 等它自己纠正要一个轮询周期。这里记下「刚保存的」与「刚删除的」,只在列表数据仍是旧版本时生效。
  const [saved, setSaved] = useState<Map<string, { from: string; to: Memory }>>(new Map());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const all = useMemo(
    () =>
      (data?.memories ?? [])
        .filter((m) => !removed.has(m.file))
        .map((m) => {
          const p = saved.get(m.file);
          // rev 还是保存前的那个 = 旧响应,用保存结果顶上;否则以服务端为准(可能又被别处改了)
          return p && m.rev === p.from ? { ...m, ...p.to, sharedWith: m.sharedWith } : m;
        }),
    [data, saved, removed],
  );
  const trash = useMemo(() => trashPoll.data?.trash ?? [], [trashPoll.data]);
  const query = q.trim();

  // 搜索防抖:FTS5 服务端检索。data 变了(编辑 / 删除后)也重搜,结果不留旧内容
  useEffect(() => {
    if (!query || trashView) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api.searchMemories(query).then((r) => setResults(r.memories), () => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query, trashView, data]);

  const facets = useMemo(() => projectFacets(all), [all]);
  /** 回收站条目 → 回收记录(恢复时要 id);按对象身份对应,同一路径删过两次也不会串 */
  const trashOf = useMemo(() => new Map<Memory, TrashedMemory>(trash.map((t) => [t.memory, t])), [trash]);

  // 搜索 + 类型过滤后的全集(不含项目过滤):各项目胶囊上的数字取自这里
  const pool = useMemo(() => {
    const source = trashView ? trash.map((t) => t.memory).filter((m) => matchesQuery(m, query)) : (results ?? all);
    return type === 'all' ? source : source.filter((m) => m.type === type);
  }, [trashView, trash, results, all, type, query]);
  const counts = useMemo(() => countByProject(pool), [pool]);
  const list = useMemo(
    () => orderByFacets(trashView || !project ? pool : pool.filter((m) => m.project === project), facets),
    [pool, project, trashView, facets],
  );
  const others = pool.length - list.length;

  // 选中项按文件路径记:轮询刷新、筛选变化后只要它还在列表里就不跳。宽屏默认选第一条(右栏不留白)
  const cur = list.find((m) => m.file === selFile) ?? (narrow ? null : (list[0] ?? null));
  const curIdx = cur ? list.indexOf(cur) : -1;

  // ---------- 编辑态的进出 ----------
  const editRef = useRef(edit);
  editRef.current = edit;
  /** 离开编辑态前的统一关口:有改动先问,没改动直接走 */
  const leaveEdit = useCallback(async () => {
    const d = editRef.current;
    if (!d) return true;
    if (isDirty(d) && !(await confirmBox(`放弃未保存的修改?\n${d.base.name}`))) return false;
    setEdit(null);
    return true;
  }, []);
  /** 凡是会换掉右栏内容的动作都走这里 */
  const nav = useCallback((fn: () => void) => void leaveEdit().then((ok) => ok && fn()), [leaveEdit]);

  const startEdit = useCallback(async (m: Memory) => {
    try {
      const { memory: d } = await api.memoryDetail(m.file);
      setEdit({ base: d, description: d.description, type: d.type, body: d.body, indexHook: d.indexHook ?? '', conflict: false, saving: false });
    } catch (e) {
      toast(`读取失败:${errMsg(e)}`);
    }
  }, []);

  // 进入编辑态后把焦点放进正文(等表单挂载完,不能在 setEdit 之后立刻 focus)
  const editingFile = edit?.base.file;
  useEffect(() => {
    // preventScroll:否则正文框被滚进视野,上面的类型 / 索引摘要两栏反而被顶出去
    if (editingFile) editBodyRef.current?.focus({ preventScroll: true });
  }, [editingFile]);

  const save = useCallback(
    async (force: boolean) => {
      const d = editRef.current;
      if (!d || d.saving || !isDirty(d) || !d.body.trim()) return;
      setEdit({ ...d, saving: true });
      try {
        const r = await api.updateMemory({
          file: d.base.file, description: d.description, type: d.type, body: d.body, indexHook: d.indexHook, rev: d.base.rev, force,
        });
        if ('conflict' in r) {
          setEdit({ ...d, saving: false, conflict: true });
          return;
        }
        setSaved((prev) => new Map(prev).set(d.base.file, { from: d.base.rev, to: r.memory }));
        setEdit(null);
        refresh();
        toast(d.indexHook !== (d.base.indexHook ?? '') ? '已保存,MEMORY.md 的索引摘要已更新' : '已保存');
      } catch (e) {
        setEdit({ ...d, saving: false });
        toast(`保存失败:${errMsg(e)}`);
      }
    },
    [refresh],
  );

  // ---------- 删除 / 恢复 ----------
  const refreshAll = useCallback(() => {
    refresh();
    trashPoll.refresh();
  }, [refresh, trashPoll]);

  const restore = useCallback(
    async (id: string) => {
      try {
        const { file } = await api.restoreMemory(id);
        setRemoved((prev) => {
          const next = new Set(prev);
          next.delete(file);
          return next;
        });
        toast('已恢复,索引行已写回 MEMORY.md');
      } catch (e) {
        toast(`恢复失败:${errMsg(e)}`);
      }
      refreshAll();
    },
    [refreshAll],
  );

  const doDelete = async (m: Memory, mode: 'file' | 'unmount' | 'all') => {
    setDelAsk(null);
    setDrawer(false);
    try {
      const { trashed } = await api.deleteMemory(m.file, mode);
      setRemoved((prev) => new Set(prev).add(m.file));
      toast(mode === 'unmount' ? `已从 ${m.project} 卸载` : '已移入回收站', { label: '撤销', run: () => void restore(trashed.id) });
    } catch (e) {
      toast(`删除失败:${errMsg(e)}`);
    }
    refreshAll();
  };

  // ---------- 导航 ----------
  const select = (m: Memory) =>
    nav(() => {
      setSelFile(m.file);
      if (narrow) setDrawer(true);
    });
  const pickProject = (p: string | null) =>
    nav(() => {
      setMenuOpen(false);
      // 再点一次已选中的项目 = 回到全部(与会话页过滤胶囊的开关语义一致)
      setProject(p === project ? null : p);
      setSelFile(null);
      if (listRef.current) listRef.current.scrollTop = 0;
    });
  const toggleTrash = () =>
    nav(() => {
      setTrashView((v) => !v);
      setProject(null);
      setQ('');
      setType('all');
      setSelFile(null);
      setDrawer(false);
    });
  const openByName = (name: string) => {
    const t = all.find((m) => m.name === name && m.project === cur?.project) ?? all.find((m) => m.name === name);
    if (!t) {
      toast(`找不到经验 ${name}(可能已删除或改名)`);
      return;
    }
    nav(() => {
      setTrashView(false);
      setQ('');
      setType('all');
      setProject(t.project);
      setSelFile(t.file);
    });
  };

  // 回收站清空后自动回到经验列表
  useEffect(() => {
    if (trashView && trashPoll.data && trash.length === 0) setTrashView(false);
  }, [trashView, trashPoll.data, trash.length]);

  // 选中行滚进视野;正文栏换条回到顶部,有命中则滚到第一处
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cur?.file]);
  useEffect(() => {
    const b = bodyRef.current;
    if (!b || edit) return;
    const first = b.querySelector<HTMLElement>('.xjm-hit');
    b.scrollTop = first ? Math.max(0, first.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop - 80) : 0;
  }, [cur?.file, query, edit]);

  // ---------- 键盘 ----------
  // 监听器只挂一次,读最新状态走 ref:视图常驻期间不反复解绑重绑
  const S = useRef({ list, curIdx, cur, narrow, drawer, menuOpen, query, trashView, findKey, save, select, startEdit, leaveEdit });
  S.current = { list, curIdx, cur, narrow, drawer, menuOpen, query, trashView, findKey, save, select, startEdit, leaveEdit };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      // 视图用 display:none 切换:必须按可见性判断,否则会抢走别的页的按键
      if (!root || root.getClientRects().length === 0) return;
      if (document.querySelector('.confirm-mask, .modal.show')) return;
      const s = S.current;
      const input = inputRef.current;
      if (matchKey(e, s.findKey)) {
        e.preventDefault();
        input?.focus();
        input?.select();
        return;
      }
      if (editRef.current) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void s.save(false);
        } else if (e.key === 'Escape' && !s.drawer) {
          // 抽屉开着时 Esc 归抽屉的 onClose(它同样会先过 leaveEdit),这里不重复问
          e.preventDefault();
          void s.leaveEdit();
        }
        return; // 编辑中其余按键都归输入框
      }
      const inSearch = document.activeElement === input;
      if (e.key === 'Escape') {
        if (s.menuOpen) setMenuOpen(false);
        else if (s.drawer) return;
        else if (s.query) setQ('');
        else if (inSearch) input?.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || (isTypingTarget(e.target) && !inSearch)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!s.list.length || s.drawer) return;
        e.preventDefault();
        const next = Math.min(s.list.length - 1, Math.max(0, s.curIdx + (e.key === 'ArrowDown' ? 1 : -1)));
        setSelFile(s.list[next]!.file);
      } else if (e.key === 'Enter' && s.narrow && s.cur && !s.drawer) {
        e.preventDefault();
        setDrawer(true);
      } else if ((e.key === 'e' || e.key === 'E') && !inSearch && s.cur && !s.trashView) {
        e.preventDefault();
        void s.startEdit(s.cur);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 点别处收起「其余项目」下拉
  useEffect(() => {
    if (!menuOpen) return;
    const off = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.xjm-more')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [menuOpen]);

  // react-markdown 按引用判断插件是否变化:只在查询变了时换新实例
  const mdPlugins = useMemo(() => [rehypeMemory(query)], [query]);

  // ---------- 列表 ----------
  const row = (m: Memory) => {
    const d = descSnippet(m, query);
    return (
      <div
        className={cn('xjm-brow', m === cur && 'xjm-sel')}
        key={`${m.file}:${trashOf.get(m)?.id ?? ''}`}
        role="option"
        aria-selected={m === cur}
        onClick={() => select(m)}
      >
        <div className="xjm-brow-top">
          <TypeTag type={m.type} />
          <span className="name">
            <Hi text={m.name} q={query} />
          </span>
        </div>
        <div className="desc">
          {d.fromBody && <span className="xjm-from">正文</span>}
          <Hi text={d.text} q={query} />
        </div>
      </div>
    );
  };
  const rows: ReactNode[] = [];
  if (project || trashView) rows.push(...list.map(row));
  else {
    // 「全部」时按项目分组,组头吸顶;list 已按项目顺序排好,顺序扫一遍即可
    let i = 0;
    while (i < list.length) {
      const p = list[i]!;
      let j = i;
      while (j < list.length && list[j]!.project === p.project) j++;
      rows.push(
        <div className="xjm-bgroup" key={`g:${p.project}`}>
          <ProjChip name={p.project} path={p.projectPath} />
          <span className="xjm-n">{j - i}</span>
        </div>,
        ...list.slice(i, j).map(row),
      );
      i = j;
    }
  }
  const emptyMsg = trashView
    ? '回收站是空的。'
    : query
      ? `没有匹配「${query}」的经验。`
      : type !== 'all'
        ? `这里没有 ${type} 类型的经验。`
        : data
          ? '还没有经验沉淀。'
          : '加载中…';

  // ---------- 正文栏的三块:头 / 体 / 脚(宽屏放进右栏,窄屏放进抽屉) ----------
  const shown = edit?.base ?? cur;
  const meta = shown && (
    <>
      <TypeTag type={edit ? edit.type : shown.type} />
      <ProjChip name={shown.project} path={shown.projectPath} />
      {shown.sharedWith && (
        <span
          className="xjm-shared"
          title={`软链到 ~/.claude/memory-shared,同时挂载在:${shown.sharedWith.join('、') || '仅本项目'}`}
        >
          共享 · {shown.sharedWith.length + 1} 个项目
        </span>
      )}
      <span className="mono xjm-file">{shortFile(shown.file)}</span>
    </>
  );
  const acts =
    shown && !edit ? (
      trashView ? (
        <button className="btn btn-sm" onClick={() => { const t = trashOf.get(shown); if (t) void restore(t.id); }}>
          恢复
        </button>
      ) : (
        <>
          <button className="btn btn-sm" title="编辑(E)" onClick={() => void startEdit(shown)}>
            编辑<kbd>E</kbd>
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => setDelAsk(shown)}>
            删除
          </button>
        </>
      )
    ) : null;

  let body: ReactNode = null;
  let foot: ReactNode = null;
  if (edit) {
    const refs = inboundRefs(all, edit.base).length;
    const types = EDIT_TYPES.includes(edit.type) ? EDIT_TYPES : [...EDIT_TYPES, edit.type];
    const set = (patch: Partial<Draft>) => setEdit({ ...edit, ...patch });
    const dirty = isDirty(edit);
    body = (
      <div className="xjm-edit">
        {edit.base.sharedWith && (
          <div className="notice-amber">
            共享经验:保存会同时改动
            {edit.base.sharedWith.length ? ` ${edit.base.sharedWith.join('、')} 里的这一条` : '共享库里的真身'}
            (索引摘要只改本项目的)。
          </div>
        )}
        <div className="pl-row">
          <div className="pl-field">
            <label>类型</label>
            <div className="filter-tabs">
              {types.map((t) => (
                <button type="button" key={t} className={edit.type === t ? 'active' : ''} onClick={() => set({ type: t })}>
                  {TYPE_LABEL[t] ?? t}
                </button>
              ))}
            </div>
          </div>
          <div className="pl-field">
            <label>名称</label>
            <div className="xjm-name-ro">{edit.base.name}</div>
          </div>
        </div>
        <div className="help xjm-name-help">
          名称就是文件名{refs > 0 && `,另有 ${refs} 条经验用 [[${edit.base.name}]] 引用它`},不开放修改。
        </div>
        <div className="pl-field">
          <label htmlFor="xjm-e-hook">索引摘要</label>
          <textarea
            id="xjm-e-hook"
            className="input"
            rows={2}
            spellCheck={false}
            value={edit.indexHook}
            onChange={(e) => set({ indexHook: e.target.value })}
          />
          <div className="help">MEMORY.md 里这条经验的那一行。会话启动时注入上下文的是它,模型靠它决定要不要用这条经验。</div>
        </div>
        <div className="pl-field">
          <label htmlFor="xjm-e-desc">描述</label>
          <textarea
            id="xjm-e-desc"
            className="input"
            rows={2}
            spellCheck={false}
            value={edit.description}
            onChange={(e) => set({ description: e.target.value })}
          />
          <div className="help">文件 frontmatter 里的 description,列表与搜索用它。</div>
        </div>
        <div className="pl-field">
          <label htmlFor="xjm-e-body">正文</label>
          <textarea
            id="xjm-e-body"
            ref={editBodyRef}
            className="pl-body"
            spellCheck={false}
            value={edit.body}
            onChange={(e) => set({ body: e.target.value })}
          />
        </div>
      </div>
    );
    foot = (
      <>
        {edit.conflict && (
          <div className="notice-amber">
            这个文件在你编辑期间被别处改过(可能是某个会话刚更新了它)。
            <button
              onClick={() => {
                setEdit(null);
                refresh();
                toast('已载入最新内容');
              }}
            >
              放弃我的修改,载入最新
            </button>
            <button onClick={() => void save(true)}>用我的版本覆盖</button>
          </div>
        )}
        <span className="xjm-dirty">{!edit.body.trim() ? '正文不能为空' : dirty ? '有未保存的修改' : '尚未修改'}</span>
        <button className="btn btn-sm" onClick={() => void leaveEdit()}>
          取消(Esc)
        </button>
        <button className="btn btn-sm btn-primary" disabled={!dirty || edit.saving || !edit.body.trim()} onClick={() => void save(false)}>
          保存(⌘Enter)
        </button>
      </>
    );
  } else if (shown) {
    body = (
      <div
        onClick={(e) => {
          const link = (e.target as HTMLElement).closest<HTMLElement>('[data-link]')?.dataset.link;
          if (link) openByName(link);
        }}
      >
        {shown.description && (
          <p className="xjm-lede">
            <Hi text={shown.description} q={query} />
          </p>
        )}
        <div className="md xjm-md">
          <Md rehypePlugins={mdPlugins}>{normalizeMemoryBody(shown.body)}</Md>
        </div>
        {shown.truncated && <p className="xjm-trunc">正文较长,这里只显示前 8000 字;点「编辑」可看全文。</p>}
      </div>
    );
  }

  const top = facets.slice(0, CHIP_TOP);
  const rest = facets.slice(CHIP_TOP);
  const pinnedRest = project ? rest.find((f) => f.name === project) : undefined;
  const chip = (f: { name: string; path: string }) => {
    const n = counts.get(f.name) ?? 0;
    return (
      <button
        key={f.name}
        className={cn('pf-chip', project === f.name && 'on', n === 0 && 'xjm-zero')}
        style={{ ['--pc' as string]: projColor(f.name) }}
        aria-pressed={project === f.name}
        title={`${f.path} · ${n} 条经验`}
        onClick={() => pickProject(f.name)}
      >
        <span className="pf-dot" />
        {f.name} <span className="pf-n">{n}</span>
      </button>
    );
  };

  return (
    <div className="xjm-view" ref={rootRef}>
      <div className="view-head">
        <h1>经验</h1>
        <span className="sub">{data ? `${all.length} 条,来自 ${facets.length} 个项目` : '加载中…'}</span>
        <span className="spacer" />
        {(trash.length > 0 || trashView) && (
          <button className="btn btn-sm btn-quiet" onClick={toggleTrash}>
            {trashView ? '‹ 返回经验' : `回收站 ${trash.length}`}
          </button>
        )}
      </div>
      <div className="mem-toolbar">
        <label className="xjm-search">
          <Input
            ref={inputRef}
            type="search"
            placeholder={trashView ? '在回收站里找…' : '全文搜索(FTS5):这个坑以前踩过没…'}
            aria-label="搜索经验"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd className="xjm-kbd">{formatCombo(findKey)}</kbd>
        </label>
        <div className="filter-tabs">
          {TYPE_FILTERS.map((f) => (
            <button key={f} className={type === f ? 'active' : ''} onClick={() => nav(() => { setType(f); setSelFile(null); })}>
              {f === 'all' ? '全部' : f}
            </button>
          ))}
        </div>
        <span className="xjm-count">
          {(query || type !== 'all' || project || trashView) && `${list.length} 条`}
          {query && project && others > 0 && <button onClick={() => pickProject(project)}>另有 {others} 条在其它项目</button>}
        </span>
      </div>

      {trashView ? (
        <div className="notice">
          回收站:{trash.length} 条已删除的经验,文件保留在 <span className="mono">~/.xuanji/trash/memory/</span>
          ,不会被会话加载,也不会自动清理。
        </div>
      ) : (
        <div className="proj-filter" role="group" aria-label="按项目筛选">
          <span className="pf-label">项目</span>
          <button className={cn('pf-chip pf-all', !project && 'on')} aria-pressed={!project} onClick={() => project && pickProject(project)}>
            全部 <span className="pf-n">{pool.length}</span>
          </button>
          {top.map(chip)}
          {pinnedRest && chip(pinnedRest)}
          {rest.length > 0 && (
            <span className="xjm-more">
              <button className="pf-chip" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
                其余 {rest.length} 个 ▾
              </button>
              {menuOpen && (
                <div className="xjm-menu" role="menu">
                  {rest.map((f) => (
                    <button role="menuitem" key={f.name} className={project === f.name ? 'active' : ''} onClick={() => pickProject(f.name)}>
                      <span className="pf-dot" style={{ background: projColor(f.name) }} />
                      <span className="xjm-pname">{f.name}</span>
                      <span className="xjm-n">{counts.get(f.name) ?? 0}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
        </div>
      )}

      <div className="xjm-split">
        <div className="panel xjm-blist" ref={listRef} role="listbox" aria-label="经验列表">
          {rows.length > 0 ? (
            rows
          ) : (
            <Empty>
              <p>{emptyMsg}</p>
              {query && project && others > 0 && (
                <p>
                  另有 {others} 条在其它项目。
                  <button className="wikilink" onClick={() => pickProject(project)}>
                    搜全部项目
                  </button>
                </p>
              )}
            </Empty>
          )}
        </div>
        {!narrow && (
          <article className="panel xjm-pane">
            {shown ? (
              <>
                <div className="xjm-pane-head">
                  <div className="xjm-pane-top">
                    <h2>{edit ? shown.name : <Hi text={shown.name} q={query} />}</h2>
                    {acts && <span className="xjm-acts">{acts}</span>}
                  </div>
                  <div className="meta">
                    {meta}
                    {!edit && curIdx >= 0 && (
                      <span className="xjm-pos">
                        {curIdx + 1} / {list.length}
                      </span>
                    )}
                  </div>
                </div>
                <div className="xjm-pane-body" ref={bodyRef}>
                  {body}
                </div>
                {foot && <div className="xjm-pane-foot">{foot}</div>}
              </>
            ) : (
              <div className="xjm-pane-empty">{list.length ? '选一条经验查看正文。' : '没有可显示的经验。'}</div>
            )}
          </article>
        )}
      </div>

      {narrow && (
        <Drawer
          open={drawer && !!shown}
          onClose={() => nav(() => setDrawer(false))}
          title={shown?.name ?? ''}
          meta={meta}
          foot={foot ? <div className="xjm-drawer-foot">{foot}</div> : acts ? <span className="xjm-acts">{acts}</span> : undefined}
          bodyRef={bodyRef}
        >
          {body}
        </Drawer>
      )}

      {delAsk && (
        <DeleteConfirm m={delAsk} refs={inboundRefs(all, delAsk)} onCancel={() => setDelAsk(null)} onConfirm={(mode) => void doDelete(delAsk, mode)} />
      )}
    </div>
  );
}

/** 删除确认:比通用 confirmBox 多两样——列出仍在引用它的经验;共享经验要选「只卸载」还是「连真身一起」 */
function DeleteConfirm({
  m,
  refs,
  onCancel,
  onConfirm,
}: {
  m: Memory;
  refs: Memory[];
  onCancel: () => void;
  onConfirm: (mode: 'file' | 'unmount' | 'all') => void;
}) {
  const [mode, setMode] = useState<'unmount' | 'all'>('unmount');
  const others = m.sharedWith ?? [];
  const done = useRef({ onCancel, confirm: () => onConfirm(m.sharedWith ? mode : 'file') });
  done.current = { onCancel, confirm: () => onConfirm(m.sharedWith ? mode : 'file') };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      // 与 ConfirmHost 同理:吃掉整个按键,免得同一个 Enter 继续传给页面的键盘导航
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Enter') done.current.confirm();
      else done.current.onCancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="confirm-mask" onClick={onCancel}>
      <div className="confirm-box" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="c-title">删除这条经验?</div>
        <div className="c-sub mono">{m.name}</div>
        <p>
          文件移入回收目录 ~/.xuanji/trash/memory/,MEMORY.md 里的索引行一并移除;之后可以在「回收站」恢复。
        </p>
        {refs.length > 0 && (
          <div className="xjm-refs">
            仍有 {refs.length} 条经验引用它,删除后这些链接会失效:
            <br />
            {refs.slice(0, 6).map((r) => (
              <span className="wikilink" key={r.name}>
                {r.name}
              </span>
            ))}
            {refs.length > 6 && ' 等'}
          </div>
        )}
        {m.sharedWith && (
          <div className="xjm-opts">
            <label className="xjm-opt">
              <input type="radio" name="xjm-delmode" checked={mode === 'unmount'} onChange={() => setMode('unmount')} />
              <span>
                只从 {m.project} 卸载
                <small>{others.length ? `${others.join('、')} 里的这一条不受影响` : '共享库里的真身保留'}</small>
              </span>
            </label>
            <label className="xjm-opt">
              <input type="radio" name="xjm-delmode" checked={mode === 'all'} onChange={() => setMode('all')} />
              <span>
                连同共享库里的真身一起删除
                <small>所有挂载它的项目里都会消失</small>
              </span>
            </label>
          </div>
        )}
        <div className="confirm-actions">
          <button className="btn btn-sm" onClick={onCancel}>
            取消(Esc)
          </button>
          <button className="btn btn-sm btn-danger" autoFocus onClick={done.current.confirm}>
            删除(Enter)
          </button>
        </div>
      </div>
    </div>
  );
}
