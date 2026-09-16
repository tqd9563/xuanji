import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DispatchSession × 斜杠命令目录(派发输入框的联想面板)。
 *
 * 钉住三件事:
 * - init 之后主动 supportedCommands() 并发一条 commands 事件 —— init 报文自带的
 *   slash_commands 只有名字,面板要的描述与参数提示只有这个接口给。
 * - commands_changed 到达时整份替换(REPLACE 语义,不是增量合并)。
 * - 目录留在会话对象上,ws attach 时补发,免得接回会话后面板空一轮
 *   (它在 init 后即发出,长会话会被回放缓冲裁到下一条 user-echo 时吃掉)。
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
      supportedCommands: vi.fn(async () => [
        { name: 'wrapup', description: 'card', argumentHint: '' },
        { name: 'watch:watch', description: 'video', argumentHint: '<url>' },
        { name: 'heapdump', description: 'internal', argumentHint: '' },
      ]),
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
  queryCalls.length = 0;
});


describe('DispatchSession × 斜杠命令目录', () => {
  it('init 后发一条 commands 事件,内容来自 supportedCommands() 且已剔除内部命令', async () => {
    const s = new DispatchSession(tmpStorage(), { cwd: '/tmp/proj' });
    const seen: { ev: string; cmds?: { name: string }[] }[] = [];
    s.subscribe((e) => seen.push(e as never));
    fakes[0]!.push({ type: 'system', subtype: 'init', session_id: 'sid-1', model: 'fable' });
    await flush();
    await flush();

    const ev = seen.find((e) => e.ev === 'commands');
    expect(ev?.cmds?.map((c) => c.name)).toEqual(['watch:watch', 'wrapup']);
  });

  it('commands_changed 整份替换目录,不与旧目录合并', async () => {
    const s = new DispatchSession(tmpStorage(), { cwd: '/tmp/proj' });
    fakes[0]!.push({ type: 'system', subtype: 'init', session_id: 'sid-2', model: 'fable' });
    await flush();
    await flush();
    expect(s.commands.map((c) => c.name)).toEqual(['watch:watch', 'wrapup']);

    const seen: { ev: string; cmds?: { name: string }[] }[] = [];
    s.subscribe((e) => seen.push(e as never));
    fakes[0]!.push({
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ name: 'only-this', description: 'x', argumentHint: '' }],
    });
    await flush();

    expect(s.commands.map((c) => c.name)).toEqual(['only-this']);
    expect(seen.at(-1)?.cmds?.map((c) => c.name)).toEqual(['only-this']);
  });

  it('SDK 不提供 supportedCommands 时静默跳过,不打断消息泵', async () => {
    const s = new DispatchSession(tmpStorage(), { cwd: '/tmp/proj' });
    // 旧 SDK 没有这个方法。它是在消息泵的 for-await 里同步调用的,
    // 抛出去会让整条流中断、会话被打成 ended(开发中实测:13 条既有 dispatch 测试因此变红)。
    delete (fakes[0]!.iterable as Record<string, unknown>).supportedCommands;
    const seen: { ev: string; state?: string }[] = [];
    s.subscribe((e) => seen.push(e as never));
    fakes[0]!.push({ type: 'system', subtype: 'init', session_id: 'sid-old', model: 'fable' });
    await flush();
    await flush();

    expect(seen.some((e) => e.ev === 'commands')).toBe(false);
    expect(seen.some((e) => e.ev === 'status' && e.state === 'ended')).toBe(false);
    expect(s.commands).toEqual([]);
  });

  it('目录留在会话对象上供 attach 补发', async () => {
    const s = new DispatchSession(tmpStorage(), { cwd: '/tmp/proj' });
    expect(s.commands).toEqual([]);
    fakes[0]!.push({ type: 'system', subtype: 'init', session_id: 'sid-3', model: 'fable' });
    await flush();
    await flush();
    expect(s.commands.length).toBe(2);
  });
});
