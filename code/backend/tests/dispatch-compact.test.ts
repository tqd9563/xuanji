import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DispatchSession × /compact:
 * 派发框内输入 /compact 会像普通消息一样透传给 Agent SDK 的 streaming-input 队列(见
 * src/views/Dispatch.tsx submit() 未拦截 /compact,直落 d.send());真正触发压缩的是底层
 * `claude` CLI 子进程(SDK query() 内部 spawn)对该字面文本的内置识别,不是 SDK 控制协议方法
 * (Query 接口本身没有 compact() —— 已用 code/backend 侧真实 SDK 手工验证过协议)。
 * 这里只锁 DispatchSession 收到 SDK 转发出的 compacting/compact_boundary 事件后的行为:
 * - status:'compacting' → 看板保持 working,detail 提示"正在压缩上下文…"(压缩期间无 delta/assistant)
 * - compact_boundary → emit 一条 'compact' 事件带 trigger/pre/post tokens,供前端渲染压缩提示
 * 压缩失败(如"消息数不足")时 SDK 走合成 assistant 文本回复,已被既有 case 'assistant' 覆盖,不需要
 * 额外处理,故不在此重复断言。
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

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-dispatch-'));
  return new Storage(dir);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.clearAllMocks();
  fakes.length = 0;
});

describe('DispatchSession × /compact', () => {
  it('status:compacting 期间看板保持 working 并带压缩中提示', async () => {
    const storage = tmpStorage();
    const session = new DispatchSession(storage, { cwd: '/tmp/proj' });
    await flush();
    const fake = fakes[0]!;

    fake.push({ type: 'system', subtype: 'init', session_id: 'sess-c1' });
    await flush();

    fake.push({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'sess-c1' });
    await flush();

    expect(session.state).toBe('working');
    expect(session.stateDetail).toBe('正在压缩上下文…');
  });

  it('compact_boundary(手动触发)emit compact 事件带 pre/post tokens', async () => {
    const storage = tmpStorage();
    const session = new DispatchSession(storage, { cwd: '/tmp/proj' });
    await flush();
    const fake = fakes[0]!;

    fake.push({ type: 'system', subtype: 'init', session_id: 'sess-c2' });
    await flush();
    fake.push({ type: 'system', subtype: 'status', status: 'compacting', session_id: 'sess-c2' });
    await flush();
    fake.push({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'sess-c2',
      compact_metadata: { trigger: 'manual', pre_tokens: 36121, post_tokens: 1565 },
    });
    await flush();

    const compactEvent = session.events.find((e) => e.ev === 'compact');
    expect(compactEvent).toEqual({ ev: 'compact', trigger: 'manual', preTokens: 36121, postTokens: 1565 });
  });

  it('compact_boundary(自动触发,SDK 到阈值自己压)同样 emit compact 事件', async () => {
    const storage = tmpStorage();
    const session = new DispatchSession(storage, { cwd: '/tmp/proj' });
    await flush();
    const fake = fakes[0]!;

    fake.push({ type: 'system', subtype: 'init', session_id: 'sess-c3' });
    await flush();
    fake.push({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'sess-c3',
      compact_metadata: { trigger: 'auto', pre_tokens: 190000 },
    });
    await flush();

    const compactEvent = session.events.find((e) => e.ev === 'compact');
    expect(compactEvent).toEqual({ ev: 'compact', trigger: 'auto', preTokens: 190000, postTokens: undefined });
  });
});
