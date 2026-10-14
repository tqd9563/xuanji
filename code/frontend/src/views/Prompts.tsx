/**
 * 提示词:反复粘贴的开场白 / 排障模板 / 固定要求的库。
 *
 * 与「技能」「CLI 自定义斜杠命令」的分工:那两者是选中即执行;提示词是**填进输入框、改两句再发**,
 * 所以这里存的是文本而不是命令,入口在派发页(钉选 chip、`/p` 面板)。数据在自有 SQLite,跨设备同步。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { Prompt } from '@/api/types';
import { usePoll, refreshPoll } from '@/lib/hooks';
import { setDispatchIntent } from '@/lib/dispatch';
import { getAccount } from '@/lib/prefs';
import { timeAgo } from '@/lib/utils';
import { filterPromptsView, firstLine, notifyPromptsChanged, resolvePromptBody, todayStr, type PromptFilter } from '@/lib/prompts';
import { confirmBox, Drawer, Empty, toast } from '@/components/shared';
import { Input } from '@/components/ui/input';

const FILTERS: { v: PromptFilter; label: string }[] = [
  { v: 'all', label: '全部' },
  { v: 'pinned', label: '已钉选' },
  { v: 'global', label: '全局' },
  { v: 'project', label: '项目专属' },
];

/** 正文里可点插入的变量;title 是插入时的解析口径 */
const VARS: { v: string; title: string }[] = [
  { v: '{{cursor}}', title: '插入后光标停在这里' },
  { v: '{{cwd}}', title: '当前会话的工作目录' },
  { v: '{{branch}}', title: '当前 git 分支' },
  { v: '{{date}}', title: '今天,YYYY-MM-DD' },
  { v: '{{clipboard}}', title: '插入时读剪贴板' },
];

const PIN_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3z" />
  </svg>
);

/** 路径末段短名(与 ProjChip 同一口径) */
const shortName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/** 正文预览:变量染紫、{{cursor}} 画成光标 */
function PreviewBody({ body, cwd, branch }: { body: string; cwd: string; branch: string }) {
  const { text, caret } = resolvePromptBody(body.replace(/\{\{cursor\}\}/g, '\u0000'), { cwd, branch, date: todayStr(), clipboard: '（剪贴板内容）' });
  // \0 是 {{cursor}} 的占位(resolvePromptBody 会把真 {{cursor}} 吃掉,这里要保留位置画光标)
  const i = text.indexOf('\u0000');
  const clean = text.replace(/\u0000/g, '');
  void caret;
  return (
    <div className="pl-preview">
      {i < 0 ? clean : (
        <>
          {clean.slice(0, i)}
          <span className="cur" title="光标落点" />
          {clean.slice(i)}
        </>
      )}
    </div>
  );
}

type Draft = { name: string; trig: string; cwd: string | null; pinned: boolean; body: string };
const EMPTY_DRAFT: Draft = { name: '', trig: '', cwd: null, pinned: false, body: '' };

export function Prompts() {
  const { data, refresh } = usePoll(api.prompts, 60_000);
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const prompts = useMemo(() => data?.prompts ?? [], [data]);
  const pinMax = data?.pinMax ?? 4;
  const [filter, setFilter] = useState<PromptFilter>('all');
  const [q, setQ] = useState('');
  const list = useMemo(() => filterPromptsView(prompts, filter, q), [prompts, filter, q]);
  const pinnedCount = prompts.filter((p) => p.pinned).length;

  // ---- 抽屉:editing = 正在编辑的记录;null = 新建;undefined = 关闭 ----
  const [editing, setEditing] = useState<Prompt | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const open = editing !== undefined;
  const openDrawer = (p: Prompt | null) => {
    setEditing(p);
    setDraft(p ? { name: p.name, trig: p.trig, cwd: p.cwd, pinned: p.pinned, body: p.body } : EMPTY_DRAFT);
  };
  const closeDrawer = useCallback(() => setEditing(undefined), []);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => (editing ? bodyRef.current : document.getElementById('pl-f-name'))?.focus(), 180);
    return () => clearTimeout(t);
  }, [open, editing]);

  const changed = () => {
    refresh();
    refreshPoll(api.prompts);
    notifyPromptsChanged();
  };

  const togglePin = async (p: Prompt) => {
    if (!p.pinned && pinnedCount >= pinMax) return toast(`最多钉选 ${pinMax} 条,先取消一条`);
    try {
      await api.updatePrompt(p.id, { pinned: !p.pinned });
      changed();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    const input = { ...draft, name: draft.name.trim(), trig: draft.trig.trim().toLowerCase() };
    if (!input.name || !input.trig || !input.body.trim()) return toast('名称、触发词、正文都要填');
    try {
      if (editing) await api.updatePrompt(editing.id, input);
      else await api.createPrompt(input);
      closeDrawer();
      changed();
      toast(editing ? '已保存' : '已新建,派发页输入 /p 即可用');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!(await confirmBox(`删除「${editing.name}」?不可恢复。`))) return;
    try {
      await api.deletePrompt(editing.id);
      closeDrawer();
      changed();
      toast('已删除');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  /** 把当前记录(以库里的为准,不是未保存的草稿)带去派发页,由派发页按它的目录/分支解析变量 */
  const insertInDispatch = () => {
    if (!editing) return;
    setDispatchIntent({ prompt: editing });
    closeDrawer();
    location.hash = 'dispatch';
  };

  const insertVar = (v: string) => {
    const ta = bodyRef.current;
    if (!ta) return;
    ta.setRangeText(v, ta.selectionStart, ta.selectionEnd, 'end');
    setDraft((d) => ({ ...d, body: ta.value }));
    ta.focus();
  };

  // 预览用的目录/分支:取设置里的默认工作目录,真正插入时派发页会换成当时的会话目录
  const prevCwd = draft.cwd ?? getAccount().cwd ?? '';
  const prevBranch = projectsData?.projects.find((p) => p.path === prevCwd)?.git?.branch ?? '';
  const projectPaths = projectsData?.projects.map((p) => p.path) ?? [];
  const scopeOptions = draft.cwd && !projectPaths.includes(draft.cwd) ? [draft.cwd, ...projectPaths] : projectPaths;

  return (
    <>
      <div className="view-head">
        <h1>提示词</h1>
        <span className="sub">
          {data ? (prompts.length ? `${prompts.length} 条 · ${pinnedCount} 条已钉选 · 存账户偏好,手机端同步` : '存账户偏好,手机端同步') : '加载中…'}
        </span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => openDrawer(null)}>新建</button>
      </div>
      <div className="mem-toolbar">
        <Input type="search" placeholder="搜名称、触发词或正文…" style={{ width: 320 }} value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索提示词" />
        <div className="filter-tabs">
          {FILTERS.map((f) => (
            <button key={f.v} className={filter === f.v ? 'active' : ''} onClick={() => setFilter(f.v)}>{f.label}</button>
          ))}
        </div>
      </div>

      {list.length > 0 && (
        <div className="panel">
          {list.map((p) => (
            <div className="pl-item" key={p.id} onClick={() => openDrawer(p)}>
              <button
                className={`pin${p.pinned ? ' on' : ''}`}
                title={p.pinned ? '取消钉选' : '钉选到派发页'}
                aria-label={p.pinned ? '取消钉选' : '钉选'}
                aria-pressed={p.pinned}
                onClick={(e) => { e.stopPropagation(); void togglePin(p); }}
              >
                {PIN_SVG}
              </button>
              <span className="trig">/p {p.trig}</span>
              <span className="name">{p.name}</span>
              <span className="prev">{firstLine(p.body)}</span>
              <span className={`pl-scope ${p.cwd ? 'proj' : 'global'}`} title={p.cwd ?? '所有工作目录可见'}>{p.cwd ? shortName(p.cwd) : '全局'}</span>
              <span className="uses" title={p.lastUsedAt ? `插入 ${p.uses} 次 · 最近 ${timeAgo(p.lastUsedAt)}` : '还没插入过'}>{p.uses ? `${p.uses} 次` : '—'}</span>
            </div>
          ))}
        </div>
      )}
      {data && list.length === 0 && (
        <Empty>
          {prompts.length === 0 ? (
            <>
              <p>还没有提示词。常被你反复粘贴的开场白、排障模板、固定要求都适合存在这里。</p>
              <div className="pl-empty-eg">
                <span><b>/p debug</b> 现象 / 复现路径 / 已排除 …</span>
                <span><b>/p bg</b> 本次任务背景 / 目标 / 完成标准 …</span>
                <span><b>/p en</b> 翻译 {'{{clipboard}}'} …</span>
              </div>
              <p style={{ marginTop: 16 }}><button className="btn btn-primary" onClick={() => openDrawer(null)}>新建第一条</button></p>
            </>
          ) : (
            <p>{q ? `没有匹配「${q}」的提示词。` : '这个筛选下没有提示词。'}</p>
          )}
        </Empty>
      )}

      <Drawer
        open={open}
        onClose={closeDrawer}
        title={editing ? '编辑提示词' : '新建提示词'}
        meta={editing ? (
          <>
            <span>插入 {editing.uses} 次</span>
            <span>{editing.lastUsedAt ? `最近 ${timeAgo(editing.lastUsedAt)}` : '还没插入过'}</span>
          </>
        ) : <span>保存后立刻可用,无需重启会话</span>}
        foot={
          <>
            {editing && <button className="btn btn-sm btn-danger" onClick={() => void remove()}>删除</button>}
            <span className="spacer" style={{ flex: 1 }} />
            {editing && <button className="btn btn-sm" title="填进派发页输入框" onClick={insertInDispatch}>在派发页插入</button>}
            <button className="btn btn-sm btn-primary" onClick={() => void save()}>保存</button>
          </>
        }
      >
        {open && (
          <>
            <div className="pl-row">
              <div className="pl-field">
                <label htmlFor="pl-f-name">名称</label>
                <input id="pl-f-name" className="input" style={{ width: '100%' }} placeholder="一眼能认出的短名,如「排障开场」" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="pl-field">
                <label htmlFor="pl-f-trig">触发词</label>
                <div className="pl-trig">
                  <span className="pre">/p</span>
                  <input id="pl-f-trig" className="input" placeholder="debug" spellCheck={false} value={draft.trig} onChange={(e) => setDraft({ ...draft, trig: e.target.value })} />
                </div>
                <div className="help">小写字母开头,字母 / 数字 / 短横线;派发页输入 <span className="mono">/p {draft.trig || 'debug'}</span> 回车即插入</div>
              </div>
            </div>
            <div className="pl-row">
              <div className="pl-field">
                <label htmlFor="pl-f-scope">作用域</label>
                <select id="pl-f-scope" className="input" style={{ width: '100%' }} value={draft.cwd ?? ''} onChange={(e) => setDraft({ ...draft, cwd: e.target.value || null })}>
                  <option value="">全局 · 所有工作目录可见</option>
                  {scopeOptions.map((p) => (
                    <option key={p} value={p}>仅 {shortName(p)} · {p}</option>
                  ))}
                </select>
              </div>
              <div className="pl-field">
                <label>钉选</label>
                <label className="pl-switch">
                  <span
                    className={`switch${draft.pinned ? ' on' : ''}`}
                    role="switch"
                    aria-checked={draft.pinned}
                    aria-label="钉选"
                    tabIndex={0}
                    onClick={() => setDraft({ ...draft, pinned: !draft.pinned })}
                    onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setDraft({ ...draft, pinned: !draft.pinned }); } }}
                  />
                  <span>新会话空输入框时显示为快捷 chip<br /><small>最多 {pinMax} 条,与手机端同步</small></span>
                </label>
              </div>
            </div>
            <div className="pl-field">
              <label htmlFor="pl-f-body">正文</label>
              <textarea id="pl-f-body" ref={bodyRef} className="pl-body" spellCheck={false} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              <div className="pl-vars">
                <span className="lab">插入变量</span>
                {VARS.map((v) => (
                  <button key={v.v} type="button" title={v.title} onClick={() => insertVar(v.v)}>{v.v}</button>
                ))}
              </div>
            </div>
            <div className="pl-field">
              <label>插入效果预览 <small style={{ fontWeight: 400, color: 'var(--faint)' }}>· 按默认工作目录解析,插入时以当时会话为准</small></label>
              <PreviewBody body={draft.body || '（正文为空）'} cwd={prevCwd} branch={prevBranch} />
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}
