import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DispatchSession 的接回(attach)回放缓冲。
 *
 * 2026-09-10 实测缺陷:一个 4 轮会话在缓冲里塞了 1849 条 delta / thinking-delta,撞上 2000 条上限后
 * 头部被裁,4 条 user-echo 只剩最后 1 条;而 ws 告诉前端的补历史分界仍是进程启动时间,jsonl 补回来
 * 的是空集 —— ⌘⇧O 轮次目录于是只列 1 轮。这里钉住三条规则:
 * 1. 连续 delta 合并成一条,流本身仍逐条推给订阅者(前端打字机效果不变);
 * 2. 超限裁剪到下一条 user-echo 为止,缓冲永远从一轮开头起算;
 * 3. replayBefore 随裁剪前移到缓冲首条事件的时刻,前端据此从 jsonl 补齐被裁部分。
 */

const { makeFakeQuery, fakes } = vi.hoisted(() => {
  function makeFakeQuery() {
    const queue: unknown[] = [];
    const waiters: ((r: IteratorResult<unknown>) => void)[] = [];
    let closed = false;
    const push = (v: unknown) => {
      const w = waiters.shift();
      if (w) w({ value: v, done: false });
      else queue.push(v);
    };
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      getContextUsage: vi.fn(async () => ({ percentage: 0 })),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({ rate_limits_available: false })),
    };
    return { iterable, push, close: () => (closed = true) };
  }
  return { makeFakeQuery, fakes: [] as ReturnType<typeof makeFakeQuery>[] };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    const f = makeFakeQuery();
    fakes.push(f);
    return f.iterable;
  }),
}));
vi.mock('../src/adapters/notify.js', () => ({ notifyMac: vi.fn() }));

const { DispatchSession } = await import('../src/services/dispatch.js');
const { Storage } = await import('../src/storage/db.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const textDelta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
});

async function newSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-replay-'));
  const session = new DispatchSession(new Storage(dir), { cwd: '/tmp/proj' });
  await flush();
  const fake = fakes[fakes.length - 1]!;
  fake.push({ type: 'system', subtype: 'init', session_id: 'sess-r' });
  await flush();
  return { session, fake };
}

const origCap = DispatchSession.REPLAY_CAP;
afterEach(() => {
  DispatchSession.REPLAY_CAP = origCap;
  vi.clearAllMocks();
  fakes.length = 0;
});

describe('DispatchSession 回放缓冲', () => {
  it('连续 delta 合并成一条缓冲事件,订阅者仍逐条收到', async () => {
    const { session, fake } = await newSession();
    const live: string[] = [];
    session.subscribe((e) => {
      if (e.ev === 'delta') live.push(e.text);
    });
    for (const t of ['你', '好', ',', '世界']) fake.push(textDelta(t));
    await flush();

    expect(live).toEqual(['你', '好', ',', '世界']);
    expect(session.events.filter((e) => e.ev === 'delta')).toEqual([{ ev: 'delta', text: '你好,世界' }]);
  });

  it('超限时裁到下一条 user-echo:缓冲从一轮开头起算,replayBefore 前移到缓冲首条', async () => {
    const { session, fake } = await newSession();
    const before = Date.now();
    expect(session.replayBefore).toBe(session.startedAt);

    // 先跑两轮,再把上限压到「裁剪点落在第 1 轮内部」:第 3 轮的第一条事件即触发裁剪
    session.send('第一轮');
    fake.push(textDelta('答一'));
    fake.push({ type: 'assistant', message: { content: [{ type: 'text', text: '答一' }] } });
    await flush();
    session.send('第二轮');
    fake.push(textDelta('答二'));
    await flush();
    const echoes = () => session.events.filter((e) => e.ev === 'user-echo').map((e) => e.text);
    expect(echoes()).toEqual(['第一轮', '第二轮']);
    // 缓冲开头还有 init/status 等轮前事件;上限 = 总量 - (第 1 轮 echo 的下标 + 1),
    // 让溢出量正好越过第 1 轮的 echo,按规则要裁到第 2 轮的 echo 为止
    const firstEcho = session.events.findIndex((e) => e.ev === 'user-echo');
    DispatchSession.REPLAY_CAP = session.events.length - firstEcho - 1;

    // 第 3 轮把总量推过上限:整个第 1 轮被裁掉(不是只裁「超出的那几条」留半截),第 2 轮完整保留
    session.send('第三轮');
    await flush();
    expect(echoes()).toEqual(['第二轮', '第三轮']);
    expect(session.events[0]).toMatchObject({ ev: 'user-echo', text: '第二轮' });
    // 分界前移:前端按它从 jsonl 补第 1 轮
    expect(session.replayBefore).toBeGreaterThanOrEqual(before);
    expect(session.replayBefore).not.toBe(session.startedAt);
  });

  it('单轮就超限时退化为按量裁,不会把缓冲清空', async () => {
    DispatchSession.REPLAY_CAP = 3;
    const { session, fake } = await newSession();
    session.send('唯一一轮');
    for (let i = 0; i < 5; i++) {
      fake.push({ type: 'assistant', message: { content: [{ type: 'text', text: `段${i}` }] } });
      await flush();
    }
    expect(session.events.length).toBe(3);
    expect(session.events.every((e) => e.ev === 'assistant')).toBe(true);
  });
});
