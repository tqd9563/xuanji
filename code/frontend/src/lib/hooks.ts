import { useCallback, useEffect, useRef, useState } from 'react';

/** 轮询数据源:intervalMs 为 0 时只取一次;refresh() 手动重取 */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => {
    fetcherRef.current().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  useEffect(() => {
    refresh();
    if (!intervalMs) return;
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
    // deps 由调用方显式传入,refresh 稳定
  }, [intervalMs, refresh, ...deps]);

  return { data, error, refresh };
}

export type ViewId = 'dashboard' | 'projects' | 'sessions' | 'dispatch' | 'skills' | 'memory' | 'cron';
export const VIEW_IDS: ViewId[] = ['dashboard', 'projects', 'sessions', 'dispatch', 'skills', 'memory', 'cron'];

/** hash 路由(与原型一致:#dashboard…#cron),浏览器前进后退可用 */
export function useHashRoute(): [ViewId, (v: ViewId) => void] {
  const read = (): ViewId => {
    const h = location.hash.slice(1) as ViewId;
    return VIEW_IDS.includes(h) ? h : 'dashboard';
  };
  const [view, setView] = useState<ViewId>(read);
  useEffect(() => {
    const onHash = () => setView(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const nav = useCallback((v: ViewId) => {
    location.hash = v;
  }, []);
  return [view, nav];
}

export function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(el.tagName);
}
