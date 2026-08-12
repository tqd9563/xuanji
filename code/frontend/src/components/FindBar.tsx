import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildMatcher, countLabel, matchRanges } from '@/lib/find';
import { cn } from '@/lib/utils';

/** 会话内查找(⌘F):在一个滚动容器里查当前已渲染的文本,仿浏览器 find-in-page。
 *
 *  实现取舍 —— 为什么不把命中包成 <mark>:
 *  被搜的是 React 渲染出来的内容(派发页还在流式追加),包裹/拆解文本节点等于在 React 背后
 *  改它托管的 DOM,重渲染时会踩 removeChild 报错。这里改为「只读地量,另起一层画」:
 *  用 Range 拿命中的矩形,画在滚动容器内的绝对定位覆盖层上,原内容一个节点都不动。
 *  代价是高亮不随文本换行自动重排,故在内容变动 / 尺寸变化时重新测量。 */

const MAX_PAINT = 400; // 超过这个数只画当前命中附近,计数与跳转仍覆盖全部
const REMEASURE_DEBOUNCE = 120;

interface Hit {
  /** 命中所在文本节点(用于建 Range 与判断可见性) */
  node: Text;
  start: number;
  end: number;
}

interface PaintRect {
  top: number;
  left: number;
  width: number;
  height: number;
  cur: boolean;
}

function collectHits(scope: HTMLElement, rx: RegExp): Hit[] {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      // 查找条自身、覆盖层不参与查找
      const p = n.parentElement;
      if (!p || p.closest('[data-find-skip]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const hits: Hit[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n as Text;
    for (const r of matchRanges(text.nodeValue ?? '', rx)) {
      hits.push({ node: text, start: r.start, end: r.end });
    }
  }
  return hits;
}

function rangeOf(hit: Hit): Range {
  const r = document.createRange();
  r.setStart(hit.node, hit.start);
  r.setEnd(hit.node, hit.end);
  return r;
}

/** 命中是否处于折叠(display:none)的子树里——此时量不到矩形,也不能滚过去 */
function isHidden(hit: Hit): boolean {
  return !hit.node.parentElement?.offsetParent && !hit.node.parentElement?.getClientRects().length;
}

export function useFindInPage(scopeRef: RefObject<HTMLElement>, enabled = true) {
  const [open, setOpen] = useState(false);
  const [summon, setSummon] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const show = useCallback(() => {
    setOpen(true);
    setSummon((n) => n + 1); // 已打开时再按 ⌘F:重放一次轮廓提示,把视线拉回来
    // 等查找条挂载后再聚焦
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);
  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // ⌘F / Ctrl+F:输入框里也放行(与浏览器原生查找的手感一致)
      if ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        // 视图切换用 display:none,所有视图始终挂载:必须按可见性判断该由谁接管 ⌘F,
        // 否则藏起来的派发页会把会话看板的 ⌘F 抢走(与 isTypingTarget 同一套判据)。
        if (!scopeRef.current || scopeRef.current.getClientRects().length === 0) return;
        e.preventDefault();
        show();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, scopeRef, show]);

  return { open, show, hide, summon, inputRef };
}

export function FindBar({
  scopeRef,
  state,
  placeholder,
  note,
}: {
  scopeRef: RefObject<HTMLElement>;
  state: ReturnType<typeof useFindInPage>;
  placeholder: string;
  /** 作用域说明(如派发页只加载了最近 N 条),不写模糊话术 */
  note?: string;
}) {
  const { open, hide, summon, inputRef } = state;
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [index, setIndex] = useState(0);
  const [rects, setRects] = useState<PaintRect[]>([]);
  const hitsRef = useRef<Hit[]>([]);
  const [total, setTotal] = useState(0);

  const matcher = useMemo(() => buildMatcher(query, { caseSensitive, regex }), [query, caseSensitive, regex]);
  const invalid = query !== '' && matcher === null;

  /** 重新收集命中。折叠工具卡里的命中照样计数,并把数量写到卡上(CSS 据此显示角标)。 */
  const collect = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    scope.querySelectorAll('[data-find-hits]').forEach((el) => el.removeAttribute('data-find-hits'));
    const hits = matcher && open ? collectHits(scope, matcher) : [];
    hitsRef.current = hits;
    setTotal(hits.length);
    setIndex((i) => (hits.length === 0 ? 0 : Math.min(i, hits.length - 1)));
    // 角标数量写在 .tc-head 上:CSS 的 attr() 只能读 ::after 所在元素自己的属性
    const perCard = new Map<Element, number>();
    for (const h of hits) {
      const head = h.node.parentElement?.closest('.toolcard:not(.open)')?.querySelector('.tc-head');
      if (head) perCard.set(head, (perCard.get(head) ?? 0) + 1);
    }
    perCard.forEach((n, head) => head.setAttribute('data-find-hits', String(n)));
  }, [matcher, open, scopeRef]);

  /** 把命中量成覆盖层坐标(相对滚动容器的内容原点,滚动不改变它,故只在内容/尺寸变化时重算) */
  const paint = useCallback(() => {
    const scope = scopeRef.current;
    const hits = hitsRef.current;
    if (!scope || hits.length === 0) {
      setRects([]);
      return;
    }
    const box = scope.getBoundingClientRect();
    const ox = box.left + scope.clientLeft - scope.scrollLeft;
    const oy = box.top + scope.clientTop - scope.scrollTop;
    // 命中过多时只画当前命中前后各 MAX_PAINT/2 个,计数与跳转不受影响
    let from = 0;
    let to = hits.length;
    if (hits.length > MAX_PAINT) {
      from = Math.max(0, index - MAX_PAINT / 2);
      to = Math.min(hits.length, from + MAX_PAINT);
    }
    const out: PaintRect[] = [];
    for (let i = from; i < to; i++) {
      const hit = hits[i]!;
      if (isHidden(hit)) continue;
      const r = rangeOf(hit);
      for (const rect of Array.from(r.getClientRects())) {
        if (rect.width === 0 && rect.height === 0) continue;
        out.push({
          top: rect.top - oy,
          left: rect.left - ox,
          width: rect.width,
          height: rect.height,
          cur: i === index,
        });
      }
      r.detach?.();
    }
    setRects(out);
  }, [index, scopeRef]);

  // 查询条件变化 → 重新收集 + 首个命中归位
  useEffect(() => {
    collect();
  }, [collect]);

  useEffect(() => {
    paint();
  }, [paint, total]);

  // 内容变动(流式输出、工具卡展开、窗口缩放)后重测:高亮是量出来的,不跟随文本重排
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope || !open) return;
    let t: number | undefined;
    const kick = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        collect();
        paint();
      }, REMEASURE_DEBOUNCE);
    };
    const mo = new MutationObserver(kick);
    mo.observe(scope, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(kick);
    ro.observe(scope);
    return () => {
      window.clearTimeout(t);
      mo.disconnect();
      ro.disconnect();
    };
  }, [collect, open, paint, scopeRef]);

  /** 跳到第 i 个命中:折叠工具卡里的先展开(点它的卡头,与用户手点等价),再滚到视野中央 */
  const goto = useCallback(
    (i: number) => {
      const hits = hitsRef.current;
      const scope = scopeRef.current;
      if (!scope || hits.length === 0) return;
      const next = ((i % hits.length) + hits.length) % hits.length;
      setIndex(next);
      const hit = hits[next]!;
      const expand = () => {
        const card = hit.node.parentElement?.closest('.toolcard:not(.open)');
        if (card) (card.querySelector('.tc-head') as HTMLElement | null)?.click();
      };
      expand();
      requestAnimationFrame(() => {
        if (isHidden(hit)) return;
        const rect = rangeOf(hit).getBoundingClientRect();
        const box = scope.getBoundingClientRect();
        const delta = rect.top - box.top - scope.clientHeight / 2 + rect.height / 2;
        scope.scrollBy({ top: delta, behavior: 'smooth' });
        paint();
      });
    },
    [paint, scopeRef],
  );

  // 输入/选项变化后自动落到第一个命中。
  // 依赖里刻意不放 goto:它的身份随 index 变,放进去会让每次上下跳都被打回第一条。
  useEffect(() => {
    if (total > 0) gotoRef.current(0);
  }, [total, query, caseSensitive, regex]);

  const gotoRef = useRef(goto);
  gotoRef.current = goto;

  const close = useCallback(() => {
    scopeRef.current?.querySelectorAll('[data-find-hits]').forEach((el) => el.removeAttribute('data-find-hits'));
    hitsRef.current = [];
    setRects([]);
    setTotal(0);
    hide();
  }, [hide, scopeRef]);

  if (!open) return null;

  const empty = invalid || (query !== '' && total === 0);

  return (
    <>
      {/* 零高度 sticky 锚点:查找条不能直接挂在滚动内容里,否则跳转命中时会被内容一起卷走 */}
      <div className="find-anchor" data-find-skip>
        <div className={cn('findbar')} key={summon} role="search">
          <span className={cn('find-field', empty && 'nores')}>
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  goto(index + (e.shiftKey ? -1 : 1));
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  close();
                }
              }}
            />
            <button
              className="find-btn toggle"
              aria-pressed={caseSensitive}
              aria-label="区分大小写"
              title="区分大小写"
              onClick={() => setCaseSensitive((v) => !v)}
            >
              <span className="g">Aa</span>
            </button>
            <button
              className="find-btn toggle"
              aria-pressed={regex}
              aria-label="使用正则表达式"
              title="使用正则表达式"
              onClick={() => setRegex((v) => !v)}
            >
              <span className="g">.*</span>
            </button>
          </span>
          <span className={cn('find-count', total > 0 && !invalid && 'num', empty && 'zero')} aria-live="polite">
            {countLabel(total, index, invalid)}
          </span>
          <button
            className="find-btn"
            disabled={total < 2}
            aria-label="上一条命中"
            title="上一条 ⇧Enter"
            onClick={() => goto(index - 1)}
          >
            <span className="g">↑</span>
          </button>
          <button
            className="find-btn"
            disabled={total < 2}
            aria-label="下一条命中"
            title="下一条 Enter"
            onClick={() => goto(index + 1)}
          >
            <span className="g">↓</span>
          </button>
          <span className="find-sep" />
          <button className="find-btn" aria-label="关闭查找" title="关闭 Esc" onClick={close}>
            ✕
          </button>
          {note && <span className="find-scope-note">{note}</span>}
        </div>
      </div>

      <div className="find-hl-layer" data-find-skip aria-hidden="true">
        {rects.map((r, i) => (
          <span
            key={i}
            className={cn('find-hl', r.cur && 'cur')}
            style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
          />
        ))}
      </div>
    </>
  );
}
