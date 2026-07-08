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

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div id={id} className={cn('dd', open && 'open', className)} ref={rootRef} title={title}>
      <button
        className="dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="dd-val">{labelOf?.(value) ?? value}</span>
        <span className="caret">▾</span>
      </button>
      <div className="dd-menu" role="listbox">
        {options.map((o) => (
          <button
            key={o}
            className={cn('dd-item', o === value && 'sel')}
            role="option"
            aria-selected={o === value}
            onClick={() => {
              onChange(o);
              setOpen(false);
            }}
          >
            {labelOf?.(o) ?? o}
            <span className="tick">✓</span>
          </button>
        ))}
      </div>
    </div>
  );
}
