/**
 * 速记浮层(⌘J):任意视图可呼出,一行文字即存。
 *
 * 键路径闭合成一条直线:⌘J → 打字 → Tab 进项目框 → 模糊搜索 → ↩ 确认(焦点自动回标题框)
 * → ↩ 保存。最后一次 ↩ 永远是「保存」,不需要在两个含义之间猜。不 Tab 直接 ↩ 则存「未指定」
 * ——临时想法经常还没想清归属,不该为此卡住记录本身。
 *
 * 位置定在顶部偏上(22vh):Spotlight/Raycast 建立的肌肉记忆位置,视线零搜索;
 * 留出的下方空间给项目下拉向下展开。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { Todo } from '@/api/types';
import { usePoll } from '@/lib/hooks';
import { fuzzyRank } from '@/lib/fuzzy';
import { cn } from '@/lib/utils';
import { toast } from '@/components/shared';

/** 未输入时展示的「最近使用」条数:高频项目在这几条里,连打字都省了 */
const RECENT_N = 5;

export function TodoPalette({ onClose, onCreated }: { onClose: () => void; onCreated: (todo: Todo, andStart: boolean) => void }) {
  const [title, setTitle] = useState('');
  const [pj, setPj] = useState<string | null>(null);
  const [pjQuery, setPjQuery] = useState('');
  const [pjMode, setPjMode] = useState(false); // 焦点是否在项目框(Tab 进入)
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const pjRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 项目列表按最近活跃排序(与 /wd 同源),未搜索时只露前 N 条
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const options = useMemo(() => {
    const ps = [...(projectsData?.projects ?? [])].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
    return ps.map((p) => p.path);
  }, [projectsData]);

  const filtered = useMemo(() => {
    const q = pjQuery.trim();
    const ranked = fuzzyRank(options, q);
    return q ? ranked : ranked.slice(0, RECENT_N);
  }, [options, pjQuery]);

  useEffect(() => setSel(0), [pjQuery]);
  useEffect(() => titleRef.current?.focus(), []);

  const shortOf = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

  const save = async (andStart: boolean) => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const { todo } = await api.createTodo(t, pj);
      onCreated(todo, andStart);
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败');
      setBusy(false);
    }
  };

  // 键盘:capture + stopImmediatePropagation 吃掉整个按键(与 WdPalette/ResumePalette 同款),
  // 否则 Esc/↑↓ 会继续传给底下视图的 document 级监听(派发页返回看板、看板导航等)。
  // save 必须经 ref 调用:监听只挂一次,直接引用会永远调用首次渲染那份闭包(title 恒为空,
  // 回车静默什么都不做——2026-07-31 Playwright 实测抓到)。
  const stateRef = useRef({ pjMode, filtered, sel });
  stateRef.current = { pjMode, filtered, sel };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = stateRef.current;
      // 中文输入法选词时的 ↩/Tab 属于 IME,不是本浮层的按键:不放行会把半截拼音当标题存掉
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        // 项目框内的 Esc 先退回标题框(收起下拉),再按一次才关闭整个浮层
        if (st.pjMode) {
          setPjMode(false);
          titleRef.current?.focus();
        } else {
          onClose();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!st.pjMode) {
          setPjMode(true);
          pjRef.current?.focus();
          return;
        }
        // 项目框内:Tab/⇧Tab 与 ↓/↑ 等价,在候选列表内循环(含末项「不指定」)
        const total = st.filtered.length + 1;
        setSel((cur) => {
          const next = e.shiftKey ? (cur - 1 + total) % total : (cur + 1) % total;
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }
      if (st.pjMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const total = st.filtered.length + 1;
        setSel((cur) => {
          const next = e.key === 'ArrowDown' ? (cur + 1) % total : (cur - 1 + total) % total;
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (st.pjMode) {
          // 确认项目 → 焦点回标题框,把最后一次 ↩ 留给「保存」
          const picked = st.sel < st.filtered.length ? st.filtered[st.sel]! : null;
          setPj(picked);
          setPjQuery(picked ? shortOf(picked) : '');
          setPjMode(false);
          titleRef.current?.focus();
          return;
        }
        void saveRef.current(e.metaKey); // ⌘↩ = 保存并立即开工
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // 监听只挂一次:可变状态一律经 stateRef 读取(与 WdPalette 同款处理)
  }, []);

  return (
    <div className="confirm-mask" onClick={onClose}>
      <div className="tp-box" role="dialog" aria-modal="true" aria-label="速记待办" onClick={(e) => e.stopPropagation()}>
        <div className="tp-head">
          <span className="glyph" aria-hidden="true">✦</span>
          <input
            ref={titleRef}
            className="tp-title"
            placeholder="速记一条待办…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setPjMode(false)}
          />
        </div>
        <div className="tp-row">
          <span className="lbl">项目</span>
          <input
            ref={pjRef}
            className={cn('tp-pj', pj && !pjMode && 'picked')}
            placeholder="未指定 · Tab 进入,输入模糊搜索"
            value={pjQuery}
            onChange={(e) => setPjQuery(e.target.value)}
            onFocus={() => setPjMode(true)}
          />
          {pjMode && (
            <div className="tp-drop" ref={listRef}>
              {filtered.map((o, i) => (
                <button
                  key={o}
                  className={cn('tp-opt', i === sel && 'hl')}
                  tabIndex={-1}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setPj(o);
                    setPjQuery(shortOf(o));
                    setPjMode(false);
                    titleRef.current?.focus();
                  }}
                >
                  <span className="n">{shortOf(o)}</span>
                  <span className="p mono">{o}</span>
                </button>
              ))}
              <button
                className={cn('tp-opt', sel === filtered.length && 'hl')}
                tabIndex={-1}
                onMouseEnter={() => setSel(filtered.length)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setPj(null);
                  setPjQuery('');
                  setPjMode(false);
                  titleRef.current?.focus();
                }}
              >
                <span className="none-mark mono">✕ 不指定项目</span>
              </button>
            </div>
          )}
        </div>
        <div className="tp-foot">
          <span><span className="kbd">↩</span> 保存</span>
          <span><span className="kbd">tab</span> 选项目 / 下一个</span>
          <span><span className="kbd">⌘↩</span> 保存并立即开工</span>
          <span><span className="kbd">esc</span> {pjMode ? '退回' : '取消'}</span>
        </div>
      </div>
    </div>
  );
}
