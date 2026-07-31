/**
 * 模糊搜索选择弹窗:↑↓ 选择 · Enter 确认 · Esc 关闭。
 * 最初为 /wd(切换工作目录)而建,后经 title/placeholder/emptyNoun 参数化,
 * /model(切换模型)复用同一实现;二者数据源都来自派发页已有 state,不新增后端接口。
 * 行布局:左列短名(labelOf)+ 右列完整值(option 本身,mono 淡色),当前值标「当前」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { fuzzyRank } from '@/lib/fuzzy';

export function WdPalette({
  value,
  options,
  labelOf,
  initialQuery = '',
  title = '切换工作目录',
  placeholder = '模糊搜索目录…(如 skill)',
  emptyNoun = '工作目录',
  onPick,
  onClose,
}: {
  value: string;
  options: string[];
  labelOf?: (v: string) => string;
  initialQuery?: string;
  /** 弹窗标题(兼作 aria-label) */
  title?: string;
  placeholder?: string;
  /** 无匹配提示里的名词:「没有匹配「x」的{emptyNoun}」 */
  emptyNoun?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 短名与路径分别打分取高层级(见 lib/fuzzy),待办速记浮层与后端共用同一口径
  const filtered = useMemo(() => fuzzyRank(options, query, labelOf), [options, query, labelOf]);

  // 打开即聚焦搜索框:WKWebView(Pake 壳)下,唤起弹窗的那次 Enter 仍处理在派发框 textarea 上,
  // 同 tick focus 与 setTimeout(0) 补抢均被真机证实可能失效(2026-07-16;派发页还有「进入自动聚焦
  // 输入框」逻辑加剧竞争,派发页拦截 /wd 时也已先 blur 派发框配合本处)。改为轮询重试直到焦点
  // 真正落座(50ms×20 上限 ~1s);Chromium 首次即成功、零额外开销。光标移到末尾以便接着输入。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const put = () => {
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    };
    put();
    let tries = 0;
    const timer = setInterval(() => {
      if (document.activeElement === el || ++tries > 20) {
        clearInterval(timer);
        return;
      }
      put();
    }, 50);
    return () => clearInterval(timer);
  }, []);
  // query 变化时选中项回到第一条

  useEffect(() => {
    setSel(0);
  }, [query]);

  // 键盘导航:capture + stopImmediatePropagation 吃掉整个按键(与 ResumePalette 同款),
  // 否则 Esc/↑↓ 会继续传给派发页的「返回看板 / 输入框历史回溯」等 document 级监听。
  // 字符键不拦截,照常落进搜索框。
  const stateRef = useRef({ filtered, sel, onPick, onClose });
  stateRef.current = { filtered, sel, onPick, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { filtered, sel, onPick, onClose } = stateRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      // Tab / Shift+Tab = 循环切换选中项(与 ↑↓ 同为导航键,到尾部回绕)。
      // 必须拦截原生行为:.rp-item 本是原生 <button>,放行 Tab 会做 DOM 焦点遍历,
      // 触发全局 :focus-visible 描边,与 sel 选中环同屏出现两圈(2026-07-16 报告的 bug)。
      // 拦截后焦点固定留在搜索框,选中态统一由 sel state 单轨驱动。
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (filtered.length === 0) return;
        setSel((cur) => {
          const next = e.shiftKey
            ? (cur - 1 + filtered.length) % filtered.length
            : (cur + 1) % filtered.length;
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (filtered.length === 0) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setSel((cur) => {
          const next = e.key === 'ArrowDown' ? Math.min(cur + 1, filtered.length - 1) : Math.max(cur - 1, 0);
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (filtered[sel]) onPick(filtered[sel]);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="confirm-mask" onClick={onClose}>
      <div
        className="rp-box wd-box"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rp-head">
          {title}
          <span className="rp-hint">↑↓/Tab 选择 · Enter 切换 · Esc 关闭</span>
        </div>
        <div className="wd-search">
          <input
            ref={inputRef}
            className="input"
            autoFocus
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {filtered.length === 0 ? (
          <div className="rp-empty">没有匹配「{query}」的{emptyNoun}</div>
        ) : (
          <div className="rp-list" ref={listRef}>
            {filtered.map((o, i) => (
              <button
                key={o}
                className={cn('rp-item', i === sel && 'sel')}
                // 退出原生 Tab 序列:选中态只由 ↑↓/鼠标 hover 驱动(sel state),
                // 不依赖/不响应原生 DOM focus,避免与 keydown 层的 Tab 拦截出现竞态双保险
                tabIndex={-1}
                onMouseEnter={() => setSel(i)}
                onClick={() => onPick(o)}
                title={o}
              >
                <span className="rp-name">{labelOf?.(o) ?? o}</span>
                {o === value && <span className="rp-meta wd-cur">当前</span>}
                <span className="wd-path mono">{o}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
