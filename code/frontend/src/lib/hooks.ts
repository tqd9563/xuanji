import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getSeenVersion, subscribeSeen } from '@/lib/utils';

/** 跨挂载 stale-while-revalidate 缓存(键 = fetcher 引用,调用点均为稳定的 api.*):
 *  视图卸载重挂时先立刻展示上次数据、后台静默刷新——切换视图不再白屏等待。 */
const pollCache = new Map<() => Promise<unknown>, unknown>();

/** 已挂载的 usePoll 消费方,按 fetcher 分组;refreshPoll() 靠它把「数据变了」推给所有在看的视图 */
const pollSubscribers = new Map<() => Promise<unknown>, Set<() => void>>();

/** 正在飞的请求,按 fetcher 合流:App(徽章)与 Sessions(看板)都以 5s 轮询 api.sessions,
 *  定时器同刻触发就是两条并发请求打到后端(用户 Pake 记录里 /api/sessions 永远成对出现);
 *  合流后同一刻只发一次,结果分发给所有调用方。 */
const pollInflight = new Map<() => Promise<unknown>, Promise<unknown>>();

/** 同一 fetcher 的并发调用共享一次请求(纯逻辑,可测) */
export function sharedFetch<T>(fetcher: () => Promise<T>): Promise<T> {
  const cur = pollInflight.get(fetcher as () => Promise<unknown>);
  if (cur) return cur as Promise<T>;
  const p = fetcher().finally(() => pollInflight.delete(fetcher as () => Promise<unknown>));
  pollInflight.set(fetcher as () => Promise<unknown>, p);
  return p;
}

/** 供测试与 refreshPoll 使用:登记一个消费方的 refresh,返回注销函数 */
export function subscribePoll(fetcher: () => Promise<unknown>, onRefresh: () => void): () => void {
  let set = pollSubscribers.get(fetcher);
  if (!set) {
    set = new Set();
    pollSubscribers.set(fetcher, set);
  }
  set.add(onRefresh);
  return () => {
    set.delete(onRefresh);
    if (set.size === 0) pollSubscribers.delete(fetcher);
  };
}

/** 数据源已知变更(如改名落库)时立即重拉,不等下一个轮询刻度:
 *  有挂载的消费方就让它们各自 refresh;没有则自己拉一次填进缓存,下次挂载直接是新数据。 */
export function refreshPoll(fetcher: () => Promise<unknown>): void {
  const subs = pollSubscribers.get(fetcher);
  if (subs && subs.size > 0) {
    for (const fn of subs) fn();
    return;
  }
  fetcher().then(
    (d) => pollCache.set(fetcher, d),
    () => undefined,
  );
}

/** 测试用:读缓存 */
export function peekPollCache<T>(fetcher: () => Promise<T>): T | undefined {
  return pollCache.get(fetcher as () => Promise<unknown>) as T | undefined;
}

/** 轮询数据源:intervalMs 为 0 时只取一次;refresh() 手动重取 */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const keyRef = useRef(fetcher as () => Promise<unknown>);
  const [data, setData] = useState<T | null>(() => (pollCache.get(keyRef.current) as T | undefined) ?? null);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => {
    // 用稳定的 keyRef 合流:各调用点传的都是稳定的 api.* 引用
    sharedFetch(keyRef.current as () => Promise<T>).then(
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
    const unsubscribe = subscribePoll(keyRef.current, refresh);
    if (!intervalMs) return unsubscribe;
    const t = setInterval(refresh, intervalMs);
    return () => {
      clearInterval(t);
      unsubscribe();
    };
    // deps 由调用方显式传入,refresh 稳定
  }, [intervalMs, refresh, ...deps]);

  return { data, error, refresh };
}

/** 订阅已读表(「待验收」判定的数据源之一):凡渲染里调用 isUnread 的视图都要用它,
 *  否则 markSeen 之后这一帧不重渲染,角标与排序要等轮询刻度才跟上。 */
export function useSeenVersion(): number {
  return useSyncExternalStore(subscribeSeen, getSeenVersion, getSeenVersion);
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
