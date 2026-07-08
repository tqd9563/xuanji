import { type ReactNode, useEffect, useState } from 'react';
import { cn, projBg, projColor } from '@/lib/utils';
import type { SessionState } from '@/api/types';

// ---------- 状态胶囊 ----------

const PILL: Record<SessionState | 'err', { cls: string; label: string }> = {
  running: { cls: 'pill-run', label: '运行中' },
  blocked: { cls: 'pill-blk', label: '等待输入' },
  idle: { cls: 'pill-idle', label: '空闲' },
  done: { cls: 'pill-done', label: '已完成' },
  err: { cls: 'pill-err', label: '错误' },
};

export function Pill({ state, label }: { state: SessionState | 'err'; label?: string }) {
  const p = PILL[state];
  return (
    <span className={cn('pill', p.cls)}>
      <span className="dot" />
      {label ?? p.label}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

/** 项目芯片:等明度分类色,悬停见完整路径 */
export function ProjChip({ name, path }: { name: string; path?: string }) {
  return (
    <span
      className="proj-chip"
      title={path ?? name}
      style={{ color: projColor(name), background: projBg(name) }}
    >
      {name}
    </span>
  );
}

// ---------- 空态 ----------

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <div className="glyph">◌</div>
      {children}
    </div>
  );
}

// ---------- 抽屉(右侧滑入,Esc/点背景关闭) ----------

export function Drawer({
  open,
  onClose,
  title,
  meta,
  foot,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  meta?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={cn('backdrop', open && 'show')} onClick={onClose} />
      <aside className={cn('drawer', open && 'show')} role="dialog" aria-modal="true">
        {open && (
          <>
            <div className="drawer-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <h2>{title}</h2>
                {meta && <div className="meta">{meta}</div>}
              </div>
              <button className="x-btn" onClick={onClose} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="drawer-body">{children}</div>
            {foot && <div className="drawer-foot">{foot}</div>}
          </>
        )}
      </aside>
    </>
  );
}

// ---------- Toast ----------

let pushToast: ((msg: string) => void) | null = null;
export function toast(msg: string) {
  pushToast?.(msg);
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    pushToast = (m) => {
      setMsg(m);
      setShow(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShow(false), 2400);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  return (
    <div className={cn('toast', show && 'show')} role="status">
      {msg}
    </div>
  );
}

// ---------- 工具调用折叠卡 ----------

export function ToolCard({ name, input, output, isError }: { name: string; input: string; output?: string; isError?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('toolcard', open && 'open')}>
      <button className="tc-head" onClick={() => setOpen(!open)}>
        <span className="fn" style={isError ? { color: 'var(--red)' } : undefined}>
          {name}
        </span>
        <span>{input}</span>
        <span className="chev">▾</span>
      </button>
      <div className="tc-body">{output ?? '(无输出)'}</div>
    </div>
  );
}
