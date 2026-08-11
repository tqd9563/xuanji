import { useCallback, useEffect, useRef, useState } from 'react';

/** 跨挂载 stale-while-revalidate 缓存(键 = fetcher 引用,调用点均为稳定的 api.*):
 *  视图卸载重挂时先立刻展示上次数据、后台静默刷新——切换视图不再白屏等待。 */
const pollCache = new Map<() => Promise<unknown>, unknown>();

/** 轮询数据源:intervalMs 为 0 时只取一次;refresh() 手动重取 */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const keyRef = useRef(fetcher as () => Promise<unknown>);
  const [data, setData] = useState<T | null>(() => (pollCache.get(keyRef.current) as T | undefined) ?? null);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => {
    fetcherRef.current().then(
      (d) => {
        pollCache.set(keyRef.current, d);
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

export type ViewId = 'dashboard' | 'projects' | 'sessions' | 'dispatch' | 'skills' | 'memory' | 'cron' | 'review' | 'worklog' | 'todo';
// 新视图一律追加在末尾:⌘1–8 的既有肌肉记忆不因新增而位移(总结 = ⌘9,待办 = ⌘0 无对应数字键,靠 ⌘J/侧栏进入)
export const VIEW_IDS: ViewId[] = ['dashboard', 'projects', 'sessions', 'dispatch', 'skills', 'memory', 'cron', 'review', 'worklog', 'todo'];

/** 移动端断点(与 DESIGN.md「手持罗盘」形态同源:重新组织信息架构而非缩放像素) */
export const MOBILE_QUERY = '(max-width: 430px)';

/** 响应式媒体查询订阅:用于需要真正不同 DOM 结构的场景(会话看板/密集表格),
 *  简单的重排交给纯 CSS 媒体查询,这里只在信息架构本身要变时才用。 */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatch(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

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

/** 事件目标是否为「用户正在打字」的输入控件——各视图键盘快捷键据此让位。
 *  必须校验可见性:视图切换用 display:none 隐藏,WebKit(Pake 壳)不像 Chrome 那样自动
 *  blur 被隐藏的元素,派发页输入框会带着焦点藏起来,看板的空格/方向键全被它吞掉,
 *  表现为「壳里按键全失灵,发条消息(焦点恰好离开)又好了」(2026-08-11 实测)。
 *  getClientRects 为空 = display:none 链上,此时它收不到用户输入,不算打字目标。 */
export function isTypingTarget(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLElement &&
    /INPUT|TEXTAREA|SELECT/.test(el.tagName) &&
    el.getClientRects().length > 0
  );
}
