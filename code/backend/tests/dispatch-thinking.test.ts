import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DispatchSession × 思考流(thinking):
 *
 * 背景 —— SDK 的 thinking 明文默认是拿不到的:不传 options.thinking 时等价于 display:'omitted',
 * thinking_delta 事件照发但明文被服务端剥成空串,只剩 signature 密文(实测 ~/.claude 下 40 个最新
 * 会话共 2158 个思考块,2119 个明文为空)。必须显式 thinking:{type:'adaptive',display:'summarized'}
 * 才有明文,且拿到的是模型自写的英文摘要而非逐字原文。
 *
 * 这里锁的是 stream_event → DispatchEvent 的映射,事件形状取自真实 SDK 抓包:
 * - 一轮回答内可有多段思考,与 tool_use 交替(实测桥问题 4 段)
 * - content_block 的 index 在每条 assistant 消息内从 0 重新计数
 *   (实测序列:thinking@0 → stop@0 → tool_use@1 → stop@1 → thinking@0 → stop@0)
 *   故 stop 只能与「当前未闭合的思考块下标」比对,不能做跨消息的全局映射
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

// 显式声明入参类型:下面要断言 query() 收到的 options.thinking,vi.fn(() => …) 会把
// mock.calls 推成空元组,取 [0] 直接类型报错
const queryMock = vi.fn((_args: { options: Record<string, unknown> }) => {
  const f = makeFakeQuery();
  fakes.push(f);
  return f.iterable;
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../src/adapters/notify.js', () => ({ notifyMac: vi.fn() }));

const { DispatchSession } = await import('../src/services/dispatch.js');
const { Storage } = await import('../src/storage/db.js');

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-thinking-'));
  return new Storage(dir);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** content_block_start(thinking) 的真实形状 */
const startThinking = (index: number) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
});
const thinkingDelta = (thinking: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
});
const blockStop = (index: number) => ({
  type: 'stream_event',
  event: { type: 'content_block_stop', index },
});

async function newSession() {
  const session = new DispatchSession(tmpStorage(), { cwd: '/tmp/proj' });
  await flush();
  const fake = fakes[fakes.length - 1]!;
  fake.push({ type: 'system', subtype: 'init', session_id: 'sess-t' });
  await flush();
  return { session, fake };
}

afterEach(() => {
  vi.clearAllMocks();
  fakes.length = 0;
});

describe('DispatchSession × 思考流', () => {
  it('query() 显式开启 summarized —— 不开就只有密文没有明文', async () => {
    await newSession();
    expect(queryMock.mock.calls[0]![0].options.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('思考明文逐段 emit,块结束时给出耗时', async () => {
    const { session, fake } = await newSession();

    fake.push(startThinking(0));
    fake.push(thinkingDelta('I should locate the actual record '));
    fake.push(thinkingDelta('rather than guess.'));
    fake.push(blockStop(0));
    await flush();

    const deltas = session.events.filter((e) => e.ev === 'thinking-delta');
    expect(deltas).toEqual([
      { ev: 'thinking-delta', text: 'I should locate the actual record ' },
      { ev: 'thinking-delta', text: 'rather than guess.' },
    ]);

    const end = session.events.find((e) => e.ev === 'thinking-end');
    expect(end).toBeDefined();
    expect((end as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('明文被剥空(display 未生效/老模型)时不 emit 空思考,避免前端渲染空气泡', async () => {
    const { session, fake } = await newSession();

    fake.push(startThinking(0));
    fake.push(thinkingDelta(''));
    fake.push(thinkingDelta(''));
    fake.push(blockStop(0));
    await flush();

    expect(session.events.filter((e) => e.ev === 'thinking-delta')).toHaveLength(0);
    // end 仍会发:前端据「没有对应的 streaming 思考卡」自行忽略,后端不猜前端状态
    expect(session.events.filter((e) => e.ev === 'thinking-end')).toHaveLength(1);
  });

  it('一轮内多段思考与 tool_use 交替,index 重置不串台', async () => {
    const { session, fake } = await newSession();

    // 真实抓包序列:thinking@0 → stop@0 → tool_use@1 → stop@1 → thinking@0 → stop@0
    fake.push(startThinking(0));
    fake.push(thinkingDelta('First pass.'));
    fake.push(blockStop(0));
    fake.push({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } },
    });
    fake.push(blockStop(1));
    fake.push(startThinking(0));
    fake.push(thinkingDelta('Second pass.'));
    fake.push(blockStop(0));
    await flush();

    expect(session.events.filter((e) => e.ev === 'thinking-delta').map((e) => (e as { text: string }).text))
      .toEqual(['First pass.', 'Second pass.']);
    // 两段思考各自闭合一次,tool_use 的 stop@1 不得被算成思考结束
    expect(session.events.filter((e) => e.ev === 'thinking-end')).toHaveLength(2);
  });

  it('思考块未闭合就转入正文时,后续同号块的 stop 不误报思考结束', async () => {
    const { session, fake } = await newSession();

    fake.push(startThinking(0));
    fake.push(thinkingDelta('interrupted…'));
    // 没有 stop@0,直接开一个 index 0 的文本块(轮次被打断后的下一条消息)
    fake.push({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    });
    fake.push(blockStop(0));
    await flush();

    expect(session.events.filter((e) => e.ev === 'thinking-end')).toHaveLength(0);
  });

  it('正文 text_delta 不受思考流影响,仍走 delta 事件', async () => {
    const { session, fake } = await newSession();

    fake.push(startThinking(0));
    fake.push(thinkingDelta('thinking text'));
    fake.push(blockStop(0));
    fake.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '正文' } },
    });
    await flush();

    expect(session.events.filter((e) => e.ev === 'delta')).toEqual([{ ev: 'delta', text: '正文' }]);
    expect(session.events.filter((e) => e.ev === 'thinking-delta')).toHaveLength(1);
  });
});
