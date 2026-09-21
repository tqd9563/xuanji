import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * 回放按需挂载:首屏只挂 FIRST_MOUNT 条,之后随滚动逐片追加。
 *
 * 为什么不是「后台空闲里把整条会话挂完」(2026-09-20 的第一版):成本只是被摊开,
 * 没有消掉。CPU profile 实测热点是 micromark(markdown 解析)+ hast-to-react,
 * 536 条事件的会话里光这两项就 ~6.5s——摊成一串 1.6s 的长任务,肉眼照样卡。
 * 改成滚动驱动后,看不到的消息根本不进 React 树,成本随「真的滚到哪」付。
 *
 * 配套另一半在 LazyMd:已挂载但不在视口内的消息先当纯文本放着,进视口才解析 markdown。
 */
export const FIRST_MOUNT = 8;
export const MOUNT_CHUNK = 8;
/** 哨兵提前这么多像素进入视野就追加下一片,滚动时不出现空白等待 */
export const LOAD_MORE_MARGIN = '300px 0px';

/** 首屏挂载条数 */
export function initialMount(total: number, first = FIRST_MOUNT): number {
  return Math.max(0, Math.min(first, total));
}

/** 下一片挂载后的累计条数;已挂满则原样返回(调用方据此停止调度) */
export function nextMount(mounted: number, total: number, chunk = MOUNT_CHUNK): number {
  if (mounted >= total) return mounted;
  return Math.min(mounted + Math.max(1, chunk), total);
}

type IdleCb = () => void;

/** 空闲调度:优先 requestIdleCallback,不支持(Safari 旧版/测试环境)退回宏任务 */
export function scheduleIdle(cb: IdleCb): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: IdleCb, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) {
    const id = ric(cb, { timeout: 300 });
    return () => (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

/**
 * 返回当前应挂载的条数与「全部挂出来」的开关。
 * total 或 resetKey 变化(换了一条会话)即回到首屏条数。
 *
 * 追加靠列表末尾的哨兵元素进入视野来驱动,不用 scroll 事件:抽屉这类内嵌滚动体上
 * 程序化滚动不一定派发 scroll(2026-09-21 实测设了 scrollTop 也收不到事件),
 * 而 IntersectionObserver 只看几何关系,内容不足一屏时也会立刻触发。
 * mountAll 给 ⌘F 用——查找靠扫 DOM,搜之前必须把没挂的补齐,否则搜不到还没滚到的部分。
 */
export function useProgressiveMount(
  total: number,
  resetKey: unknown,
  sentinelRef?: RefObject<HTMLElement>,
  rootRef?: RefObject<HTMLElement>,
): { mounted: number; mountAll: () => void } {
  const [mounted, setMounted] = useState(() => initialMount(total));
  const totalRef = useRef(total);
  totalRef.current = total;

  useEffect(() => {
    setMounted(initialMount(total));
  }, [total, resetKey]);

  // 首屏之后在空闲里预取一片,第一次轻轻一滚就有内容
  useEffect(() => {
    if (mounted !== initialMount(total) || mounted >= total) return;
    return scheduleIdle(() => setMounted((m) => nextMount(m, totalRef.current)));
  }, [mounted, total]);

  // 哨兵进入视野 → 再追一片。mounted 变化后重新观察,让它能连续追到底
  useEffect(() => {
    const el = sentinelRef?.current;
    if (!el || mounted >= total || typeof IntersectionObserver === 'undefined') return;
    // root 必须是滚动容器本身:默认 root(视口)下祖先的裁剪照样生效,而 rootMargin
    // 只放大 root 的矩形,救不了被容器裁掉的哨兵——表现为滚到底也不追加(实测)
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setMounted((m) => nextMount(m, totalRef.current));
      },
      { root: rootRef?.current ?? null, rootMargin: LOAD_MORE_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sentinelRef, rootRef, mounted, total]);

  const mountAll = useCallback(() => setMounted(totalRef.current), []);
  return { mounted, mountAll };
}
