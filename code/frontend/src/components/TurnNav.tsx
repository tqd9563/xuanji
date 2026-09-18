/**
 * 轮次导航 —— 长会话里往回翻某一轮的两个入口,共用 lib/turns 的同一份索引。
 *
 * TurnHead(吸顶轮次头):贴在消息区顶缘,只在当前轮的提问整条滚出视口后淡入。
 *   提问还看得见时它是冗余的,常驻等于在每屏顶部收一道税。
 * TurnOutline(轮次目录,⌘⇧O):复用命令弹窗骨架(rp-box / wd-search / rp-list / rp-item),
 *   不新造一套弹窗词汇 —— /wd、/resume 练出的手感在这里必须照样管用。
 *
 * 分工:⌘F 找词,轮次目录找轮。前者要求你记得关键词,后者只要求你记得问过什么。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn, msgClock } from '@/lib/utils';
import { rankTurns, type Turn } from '@/lib/turns';

export function TurnHead({
  turn,
  total,
  hasPrev,
  hasNext,
  onJump,
  onStep,
  onOpenOutline,
}: {
  /** null = 尚无当前轮(滚在第一条提问之前),整条隐藏 */
  turn: Turn | null;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  onJump: (ord: number) => void;
  onStep: (dir: -1 | 1) => void;
  onOpenOutline: () => void;
}) {
  return (
    <div className="turn-anchor" data-find-skip>
      <div className={cn('turnhead', turn && 'show')} role="region" aria-label="当前轮次" aria-hidden={!turn}>
        {turn && (
          <>
            <span className="th-n">#{turn.ord + 1}</span>
            <span className="th-who">你</span>
            <button className="th-text" title="回到本轮提问" onClick={() => onJump(turn.ord)}>
              {turn.summary}
            </button>
            <span className="th-nav">
              <span className="th-pos">{turn.ord + 1}/{total}</span>
              <button className="th-btn" aria-label="上一轮" title="上一轮 ⌥↑" disabled={!hasPrev} onClick={() => onStep(-1)}>↑</button>
              <button className="th-btn" aria-label="下一轮" title="下一轮 ⌥↓" disabled={!hasNext} onClick={() => onStep(1)}>↓</button>
              <span className="th-sep" />
              <button className="th-btn" aria-label="轮次目录" title="轮次目录 ⌘⇧O" onClick={onOpenOutline}>≡</button>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export function TurnOutline({
  turns,
  curOrd,
  onPick,
  onClose,
}: {
  turns: Turn[];
  /** 当前轮:打开时选中项落在这里,所以第一下 ↑ 天然就是「上一轮」 */
  curOrd: number | null;
  onPick: (ord: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => rankTurns(turns, query), [turns, query]);
  const unloaded = turns.filter((t) => !t.loaded).length;

  // 打开即把选中项落在当前轮(无当前轮则落最后一轮——那是刚发生的事)
  useEffect(() => {
    const i = curOrd === null ? turns.length - 1 : turns.findIndex((t) => t.ord === curOrd);
    setSel(Math.max(0, i));
  }, []);
  // 查询变化后选中项回到第一条(= 最佳匹配)
  useEffect(() => {
    if (query) setSel(0);
  }, [query]);
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  // 打开即聚焦搜索框:轮询重试直到焦点真正落座,与 WdPalette 同款——
  // WKWebView(Pake 壳)下同 tick focus 与 setTimeout(0) 均被真机证实可能失效。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    let tries = 0;
    const timer = setInterval(() => {
      if (document.activeElement === el || ++tries > 20) return clearInterval(timer);
      el.focus();
    }, 50);
    return () => clearInterval(timer);
  }, []);

  // 键盘导航:capture + stopImmediatePropagation 吃掉整个按键,否则 ↑↓ 会继续传给
  // 派发页的「输入框历史回溯」、Esc 会被「返回看板」抢走(与 WdPalette 同一处理)。
  const stateRef = useRef({ filtered, sel, onPick, onClose });
  stateRef.current = { filtered, sel, onPick, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { filtered, sel, onPick, onClose } = stateRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!filtered.length) return;
        setSel((c) => (e.shiftKey ? (c - 1 + filtered.length) % filtered.length : (c + 1) % filtered.length));
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!filtered.length) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setSel((c) => (e.key === 'ArrowDown' ? Math.min(c + 1, filtered.length - 1) : Math.max(c - 1, 0)));
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const t = filtered[sel];
        if (t) onPick(t.ord);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="confirm-mask" onClick={onClose} data-find-skip>
      <div className="rp-box wd-box to-box" role="dialog" aria-modal="true" aria-label="轮次目录" onClick={(e) => e.stopPropagation()}>
        <div className="rp-head">
          轮次目录
          <span className="rp-hint">↑↓/Tab 选择 · Enter 跳转 · Esc 关闭</span>
        </div>
        <div className="wd-search">
          <input
            ref={inputRef}
            className="input"
            placeholder="模糊搜索你问过的话…"
            aria-label="搜索轮次"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {filtered.length === 0 ? (
          <div className="rp-empty">没有匹配「{query.trim()}」的轮次。目录只含你发出的消息,找 Claude 回答里的词用 ⌘F。</div>
        ) : (
          <div className="rp-list" ref={listRef} role="listbox">
            {filtered.map((t, i) => (
              <button
                key={t.ord}
                type="button"
                role="option"
                aria-selected={i === sel}
                className={cn('rp-item', i === sel && 'sel', !t.loaded && 'unloaded')}
                onMouseMove={() => setSel(i)}
                onClick={() => onPick(t.ord)}
              >
                <span className="to-n">#{t.ord + 1}</span>
                <span className="to-text" title={t.text}>{t.summary}</span>
                {!t.loaded && <span className="to-tag">未加载</span>}
                {t.ord === curOrd && <span className="to-cur">当前</span>}
                <span className="to-time">{msgClock(t.ts) ?? ''}</span>
              </button>
            ))}
          </div>
        )}
        <div className="to-foot">
          <span>
            {turns.length} 轮
            {unloaded > 0 && ` · 前 ${unloaded} 轮尚未加载,选中即回填`}
          </span>
          <span className="spacer" />
          <kbd>⌥↑</kbd>
          <kbd>⌥↓</kbd>
          <span>不开目录也能逐轮跳</span>
        </div>
      </div>
    </div>
  );
}
