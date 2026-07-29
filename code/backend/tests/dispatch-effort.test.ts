import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DispatchSession × 思考深度(SDK effort):
 * effort 与 model 一样是「会话级」设定 —— Agent SDK 的 Query 接口只有 setModel(),没有
 * setEffort()(0.3.204 sdk.d.ts 已核),所以只能在 query() 建会话时下发。这里锁两件事:
 * - 建会话时 effort 原样进 query() options(不再落到 SDK 默认档)
 * - parseEffort 只放行 SDK EffortLevel 的 5 个合法值,脏值/undefined 一律当未指定,
 *   避免前端(或未来的 REST 入口)把任意字符串灌进 SDK 触发子进程侧报错
 */

const { makeFakeQuery, fakes, queryCalls } = vi.hoisted(() => {
  function makeFakeQuery() {
    const queue: unknown[] = [];
    const waiters: ((r: IteratorResult<unknown>) => void)[] = [];
    let closed = false;
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
    return {
      iterable,
      push: (v: unknown) => {
        const w = waiters.shift();
        if (w) w({ value: v, done: false });
        else queue.push(v);
      },
      close: () => (closed = true),
    };
  }
  return {
    makeFakeQuery,
    fakes: [] as ReturnType<typeof makeFakeQuery>[],
    queryCalls: [] as { options: Record<string, unknown> }[],
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: Record<string, unknown> }) => {
    queryCalls.push(args);
    const f = makeFakeQuery();
    fakes.push(f);
    return f.iterable;
  }),
}));
vi.mock('../src/adapters/notify.js', () => ({ notifyMac: vi.fn() }));

const { DispatchSession, parseEffort } = await import('../src/services/dispatch.js');
const { Storage } = await import('../src/storage/db.js');

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-dispatch-'));
  return new Storage(dir);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.clearAllMocks();
  fakes.length = 0;
  queryCalls.length = 0;
});

describe('DispatchSession × 思考深度', () => {
  it('创建会话时 effort 透传进 query() options', async () => {
    new DispatchSession(tmpStorage(), { cwd: '/tmp/proj', model: 'claude-opus-5', effort: 'low' });
    await flush();

    expect(queryCalls[0]?.options.effort).toBe('low');
    expect(queryCalls[0]?.options.model).toBe('claude-opus-5');
  });

  it('未指定时不下发 effort(交给模型自身默认档)', async () => {
    new DispatchSession(tmpStorage(), { cwd: '/tmp/proj' });
    await flush();

    expect(queryCalls[0]?.options.effort).toBeUndefined();
  });

  it('parseEffort 只放行 SDK 合法档位,脏值当未指定', () => {
    for (const v of ['low', 'medium', 'high', 'xhigh', 'max']) expect(parseEffort(v)).toBe(v);
    for (const v of ['LOW', 'ultra', '', ' low', 0, null, undefined, {}]) expect(parseEffort(v)).toBeUndefined();
  });
});
