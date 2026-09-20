import { useEffect, useState } from 'react';

/**
 * 回放分片挂载:首屏只挂前 FIRST 条,其余在浏览器空闲时逐片追加。
 *
 * 为什么要分片:回放抽屉一次性挂载整条会话(工具卡 + 每条助手消息各走一遍
 * react-markdown 的 remark 全量解析),实测 88 条事件就能把主线程堵住 1~2s
 * (2026-09-20 longtask 实测:首次开 432ms + 1944ms),表现为「点进会话要等
 * 一两秒才刷出历史」。分片后首屏只付前 FIRST 条的代价,剩下的在 idle 里补齐。
 *
 * 分片从头开始而不是从尾部:抽屉是从顶部开始读的,先挂尾部会让可视区内容后到,
 * 反而更像卡顿。追加不改变已挂载部分的 DOM,不会把用户正在看的位置顶走。
 */
export const FIRST_MOUNT = 30;
export const MOUNT_CHUNK = 15;

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
 * 返回当前应挂载的条数。total 或 resetKey 变化(换了一条会话)即回到首屏条数。
 */
export function useProgressiveMount(total: number, resetKey: unknown): number {
  const [mounted, setMounted] = useState(() => initialMount(total));
  useEffect(() => {
    setMounted(initialMount(total));
  }, [total, resetKey]);
  useEffect(() => {
    if (mounted >= total) return;
    return scheduleIdle(() => setMounted((m) => nextMount(m, total)));
  }, [mounted, total]);
  return mounted;
}
