/** 自绘向上弹出下拉(原生 select 弹层不可主题化,见 DESIGN.md 组件章) */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export function DropUp({
  id,
  value,
  options,
  onChange,
  className,
  title,
  labelOf,
}: {
  id?: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  className?: string;
  title?: string;
  labelOf?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // WKWebView(Pake 壳)+ 触摸板轻触:首次 tap 常被当成 hover,onClick 要点第二次才派发。
  // 改由 onPointerDown 在物理按下时立即响应;keyboard(无 pointerdown)仍走 onClick。
  // pointerdown 后浏览器会补发一次 click,用该 ref 吞掉以免双触发。
  const pointerHandled = useRef(false);
  const swallowClickAfterPointer = () => {
    if (!pointerHandled.current) return false;
    pointerHandled.current = false;
    return true;
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof PointerEvent && rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div id={id} className={cn('dd', open && 'open', className)} ref={rootRef} title={title}>
      <button
        className="dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onPointerDown={() => {
          pointerHandled.current = true;
          setOpen((o) => !o);
        }}
        onClick={() => {
          if (swallowClickAfterPointer()) return;
          setOpen((o) => !o);
        }}
      >
        <span className="dd-val" title={labelOf?.(value) ?? value}>
          {labelOf?.(value) ?? value}
        </span>
        <span className="caret">▾</span>
      </button>
      <div className="dd-menu" role="listbox">
        {options.map((o) => (
          <button
            key={o}
            className={cn('dd-item', o === value && 'sel')}
            role="option"
            aria-selected={o === value}
            title={labelOf?.(o) ?? o}
            onPointerDown={() => {
              pointerHandled.current = true;
              onChange(o);
              setOpen(false);
            }}
            onClick={() => {
              if (swallowClickAfterPointer()) return;
              onChange(o);
              setOpen(false);
            }}
          >
            <span className="dd-item-label">{labelOf?.(o) ?? o}</span>
            <span className="tick">✓</span>
          </button>
        ))}
      </div>
    </div>
  );
}
