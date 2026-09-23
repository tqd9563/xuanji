import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * withUsage 的 stale-while-revalidate(2026-09-23):频率缓存过期后,请求不能再同步等一次
 * 全机扫描——那次扫描会把事件循环堵 4~6s,打开会话的所有请求一起变慢。
 */
let resolveScan: ((c: Record<string, number>) => void) | null = null;
const countSpy = vi.fn(
  () =>
    new Promise<Record<string, number>>((r) => {
      resolveScan = r;
    }),
);
vi.mock('../src/services/slash-usage.js', () => ({
  countSlashUsage: (...a: unknown[]) => countSpy(...(a as [])),
  applyUsage: <T extends { name: string }>(cmds: T[], counts: Record<string, number>) =>
    cmds.map((c) => ({ ...c, uses: counts[c.name] ?? 0 })),
}));

const { withUsage } = await import('../src/services/slash-commands.js');
const storage = {} as never;
const cmds = [{ name: 'model' }] as never[];

afterEach(() => vi.useRealTimers());

describe('withUsage 过期时先给旧值', () => {
  it('从没算过时等第一次;过期后立即返回旧值、后台只起一次刷新', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const first = withUsage(storage, cmds);
    resolveScan!({ model: 3 });
    expect((await first).uses).toEqual({ model: 3 });
    expect(countSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(11 * 60 * 1000); // 超过 10 分钟 TTL
    const [a, b] = await Promise.all([withUsage(storage, cmds), withUsage(storage, cmds)]);
    expect(a.uses).toEqual({ model: 3 }); // 旧值,不等扫描
    expect(b.uses).toEqual({ model: 3 });
    expect(countSpy).toHaveBeenCalledTimes(2); // 并发两次调用只起一次刷新

    resolveScan!({ model: 9 });
    await new Promise((r) => setTimeout(r, 0));
    expect((await withUsage(storage, cmds)).uses).toEqual({ model: 9 });
  });
});
