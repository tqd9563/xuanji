import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DispatchSession 的 result → idle 状态压制逻辑:
 * 顶层轮次结束(result)时,如果 SDK 的 background_tasks_changed 权威信号里还有存活后台任务
 * (如 Agent run_in_background 探索子代理),看板不应打成「空闲」——这是本文件要锁住的行为。
 * 用假的 query() 异步流驱动 DispatchSession,不连真实 Agent SDK 子进程。
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

const { DispatchSession, dispatchBoardState } = await import('../src/services/dispatch.js');
const { Storage } = await import('../src/storage/db.js');

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-dispatch-'));
  return new Storage(dir);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.clearAllMocks();
  fakes.length = 0;
});

describe('DispatchSession × 后台任务(background_tasks_changed)', () => {
  it('result 到达时仍有存活后台任务:不打成 idle,保持 running 并标注任务', async () => {
    const storage = tmpStorage();
    const session = new DispatchSession(storage, { cwd: '/tmp/proj' });
    await flush();
    const fake = fakes[0]!;

    fake.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await flush();

    fake.push({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Agent', input: { run_in_background: true, description: '探索代码库' } },
        ],
      },
    });
    await flush();

    fake.push({
      type: 'system',
      subtype: 'background_tasks_changed',
      session_id: 'sess-1',
      tasks: [{ task_id: 'bg-1', task_type: 'subagent', description: '探索代码库' }],
    });
    await flush();

    fake.push({ type: 'result', usage: {}, total_cost_usd: 0, duration_ms: 100 });
    await flush();

    // 关键断言:result 后不是 idle,看板四态映射仍是 running
    expect(session.state).toBe('working');
    expect(dispatchBoardState(session.state)).toBe('running');
    expect(session.activity).toContain('探索代码库');

    // 后台任务全部结束(空集合)才真正转 idle
    fake.push({ type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-1', tasks: [] });
    await flush();
    expect(session.state).toBe('idle');
    expect(dispatchBoardState(session.state)).toBe('idle');
  });

  it('没有后台任务时,result 后照常回到 idle(不影响常规场景)', async () => {
    const storage = tmpStorage();
    const session = new DispatchSession(storage, { cwd: '/tmp/proj' });
    await flush();
    const fake = fakes[0]!;

    fake.push({ type: 'system', subtype: 'init', session_id: 'sess-2' });
    await flush();
    fake.push({ type: 'result', usage: {}, total_cost_usd: 0, duration_ms: 50 });
    await flush();

    expect(session.state).toBe('idle');
    expect(dispatchBoardState(session.state)).toBe('idle');
  });

  it('新一轮 send() 后 turnEnded 复位:不会被上一轮的后台压制状态卡住', async () => {
    const storage = tmpStorage();
    const session = new DispatchSession(storage, { cwd: '/tmp/proj' });
    await flush();
    const fake = fakes[0]!;

    fake.push({ type: 'system', subtype: 'init', session_id: 'sess-3' });
    await flush();
    fake.push({
      type: 'system',
      subtype: 'background_tasks_changed',
      session_id: 'sess-3',
      tasks: [{ task_id: 'bg-2', task_type: 'subagent', description: '探索代码库' }],
    });
    await flush();
    fake.push({ type: 'result', usage: {}, total_cost_usd: 0, duration_ms: 10 });
    await flush();
    expect(session.state).toBe('working'); // 后台任务仍在,压制 idle

    session.send('继续下一步');
    expect(session.state).toBe('working'); // 用户手动发消息,正常回到 working
  });
});
