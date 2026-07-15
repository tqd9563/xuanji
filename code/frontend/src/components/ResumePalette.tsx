/**
 * /resume 弹窗:列出当前项目下已关闭(隐藏)的会话,↑↓ 选择 · Enter 续接 · Esc 关闭。
 * 数据源 GET /api/sessions/closed?cwd=,选中后由派发页完成 unhide + 续接。
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import { cn, timeAgo } from '@/lib/utils';
import type { ClosedSession } from '@/api/types';

export function ResumePalette({
  cwd,
  onPick,
  onClose,
}: {
  cwd: string;
  onPick: (s: ClosedSession) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<ClosedSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .closedSessions(cwd)
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [cwd]);

  // 键盘导航:capture + stopImmediatePropagation 吃掉整个按键,
  // 不拦截的话 Esc/← 会继续传给派发页的「返回看板」监听(ConfirmHost 同款处理)
  const stateRef = useRef({ sessions, sel, onPick, onClose });
  stateRef.current = { sessions, sel, onPick, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { sessions, sel, onPick, onClose } = stateRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (!sessions || sessions.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSel((cur) => {
          const next = e.key === 'ArrowDown' ? Math.min(cur + 1, sessions.length - 1) : Math.max(cur - 1, 0);
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (sessions[sel]) onPick(sessions[sel]);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="confirm-mask" onClick={onClose}>
      <div className="rp-box" role="dialog" aria-modal="true" aria-label="恢复已关闭会话" onClick={(e) => e.stopPropagation()}>
        <div className="rp-head">
          恢复已关闭会话
          <span className="rp-hint">↑↓ 选择 · Enter 续接 · Esc 关闭</span>
        </div>
        {error && <div className="rp-empty">加载失败:{error}</div>}
        {!error && sessions === null && <div className="rp-empty">加载中…</div>}
        {!error && sessions?.length === 0 && (
          <div className="rp-empty">当前项目没有已关闭的会话(看板 × 关闭的会话会出现在这里)</div>
        )}
        {!error && !!sessions?.length && (
          <div className="rp-list" ref={listRef}>
            {sessions.map((s, i) => (
              <button
                key={s.sessionId}
                className={cn('rp-item', i === sel && 'sel')}
                onMouseEnter={() => setSel(i)}
                onClick={() => onPick(s)}
              >
                <span className="rp-name">{s.name}</span>
                <span className="rp-meta mono">{s.sessionId.slice(0, 8)}</span>
                <span className="rp-meta">关闭于 {timeAgo(s.hiddenAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
