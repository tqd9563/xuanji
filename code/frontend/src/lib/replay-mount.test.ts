import { describe, expect, it, vi } from 'vitest';
import { FIRST_MOUNT, initialMount, MOUNT_CHUNK, nextMount, scheduleIdle } from './replay-mount';

describe('回放分片挂载的步进', () => {
  it('首屏不超过 FIRST_MOUNT,短会话一次挂完', () => {
    expect(initialMount(1000)).toBe(FIRST_MOUNT);
    expect(initialMount(7)).toBe(7);
    expect(initialMount(0)).toBe(0);
  });

  it('逐片追加直到挂满,且不会越过总数', () => {
    let m = initialMount(100);
    const steps: number[] = [m];
    for (let i = 0; i < 50 && m < 100; i++) {
      m = nextMount(m, 100);
      steps.push(m);
    }
    expect(steps[0]).toBe(FIRST_MOUNT);
    expect(steps[1]).toBe(FIRST_MOUNT + MOUNT_CHUNK);
    expect(steps.at(-1)).toBe(100); // 逐片推进到挂满,末片被总数截断
    expect(nextMount(100, 100)).toBe(100); // 挂满后不动,调度据此停下
  });

  it('chunk 非法时至少推进一条,不会原地死循环', () => {
    expect(nextMount(5, 10, 0)).toBe(6);
    expect(nextMount(5, 10, -3)).toBe(6);
  });
});

describe('scheduleIdle', () => {
  it('无 requestIdleCallback 时退回定时器,且可取消', () => {
    vi.useFakeTimers();
    const had = 'requestIdleCallback' in globalThis;
    expect(had).toBe(false); // 测试环境确实没有,这条断言保证下面走的是兜底分支
    const cb = vi.fn();
    const cancel = scheduleIdle(cb);
    cancel();
    vi.advanceTimersByTime(100);
    expect(cb).not.toHaveBeenCalled();
    scheduleIdle(cb);
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
