import { describe, expect, it, vi } from 'vitest';
import { peekPollCache, refreshPoll, sharedFetch, subscribePoll } from './hooks';

/**
 * /rename 落库后看板卡片要立刻换名,不能等 5s 轮询刻度(2026-09-15 用户反馈改名后卡 1–2s)。
 * refreshPoll 是这条通路的唯一入口:有挂载消费方就推 refresh;没有则自己拉一次填缓存。
 */
describe('refreshPoll 让已知变更绕过轮询刻度', () => {
  it('有消费方时逐个触发 refresh,不自己拉数据', () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribePoll(fetcher, a);
    const offB = subscribePoll(fetcher, b);
    refreshPoll(fetcher);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    offA();
    offB();
  });

  it('注销后不再被触发', () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const a = vi.fn();
    subscribePoll(fetcher, a)();
    refreshPoll(fetcher);
    expect(a).not.toHaveBeenCalled();
  });

  it('无消费方时自己拉一次并写进缓存,下次挂载直接拿到新数据', async () => {
    const fetcher = vi.fn(async () => ({ v: 42 }));
    refreshPoll(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(peekPollCache(fetcher)).toEqual({ v: 42 }));
  });

  it('无消费方且拉取失败时不抛出', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(() => refreshPoll(fetcher)).not.toThrow();
    await Promise.resolve();
    expect(peekPollCache(fetcher)).toBeUndefined();
  });
});

describe('/rename 成功后必须调用 refreshPoll(api.sessions)', () => {
  const FILES = import.meta.glob('../views/Dispatch.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const src = Object.values(FILES)[0] ?? '';
  it('renameSession 调用后紧跟 refreshPoll(api.sessions)', () => {
    const i = src.indexOf('await api.renameSession(');
    expect(i).toBeGreaterThan(-1);
    const after = src.slice(i, i + 400);
    expect(after).toContain('refreshPoll(api.sessions)');
  });
});

describe('sharedFetch 同 fetcher 并发合流', () => {
  it('同刻两次调用只真正请求一次,结果相同;完成后再次调用重新请求', async () => {
    let n = 0;
    const fetcher = () => new Promise<number>((r) => setTimeout(() => r(++n), 10));
    const [a, b] = await Promise.all([sharedFetch(fetcher), sharedFetch(fetcher)]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(await sharedFetch(fetcher)).toBe(2);
  });
});
