import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 派发会话空闲自动退出:验收中/空闲(非 running/blocked)、无进行中回合/旁路提问,
 * 超过 N 分钟无输入/输出 → 结束子进程但保留会话(卡片/记录/回放),下条消息以 --resume 冷启动。
 * 用假 query() 驱动,不连真实 SDK 子进程;假流在 interrupt 时结束,模拟进程退出。
 */
const { fakes, calls } = vi.hoisted(() => ({ fakes: [] as any[], calls: [] as any[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((arg: any) => {
    calls.push(arg);
    const queue: unknown[] = [];
    const waiters: ((r: IteratorResult<unknown>) => void)[] = [];
    let closed = false;
    const close = () => {
      closed = true;
      while (waiters.length) waiters.shift()!({ value: undefined, done: true });
    };
    const f = {
      push: (v: unknown) => {
        const w = waiters.shift();
        if (w) w({ value: v, done: false });
        else queue.push(v);
      },
      close,
      iterable: {
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<unknown>> => {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
              if (closed) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
        interrupt: vi.fn(async () => close()),
        setModel: vi.fn(async () => {}),
        getContextUsage: vi.fn(async () => ({ percentage: 0 })),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({ rate_limits_available: false })),
      },
    };
    fakes.push(f);
    return f.iterable;
  }),
}));
vi.mock('../src/adapters/notify.js', () => ({ notifyMac: vi.fn() }));

const { createDispatch, sweepIdleDispatches, liveDispatches, canResume } = await import('../src/services/dispatch.js');
const { Storage } = await import('../src/storage/db.js');
const { sanitize } = await import('../src/services/prefs.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const MIN = 60_000;

/** 起一个会话并跑完一个回合(init → result),停在 idle */
async function idleSession(sid: string) {
  const storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-idle-')));
  const s = createDispatch(storage, { cwd: '/tmp', model: 'm1', permissionMode: 'bypassPermissions' });
  const f = fakes[fakes.length - 1];
  s.send('hi');
  f.push({ type: 'system', subtype: 'init', session_id: sid, model: 'm1' });
  f.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {} });
  await flush();
  await flush();
  return { s, f, storage };
}

describe('派发会话空闲自动退出', () => {
  it('超时 → 结束子进程,会话保留且仍是空闲(不进已完成)', async () => {
    const { s, f, storage } = await idleSession('sess-timeout');
    expect(s.state).toBe('idle');
    const exited = await sweepIdleDispatches(30, s.lastEventAt + 30 * MIN);
    await flush();
    expect(exited).toEqual(['sess-timeout']);
    expect(f.iterable.interrupt).toHaveBeenCalled();
    expect(s.hibernated).toBe(true);
    expect(s.state).toBe('idle');
    // 看板:仍由进程内会话提供卡片,带 idleExited,状态不是 ended
    const live = liveDispatches().find((d) => d.sessionId === 'sess-timeout')!;
    expect(live).toMatchObject({ state: 'idle', idleExited: true });
    // 快照落库的是 idle 而不是 ended:后端重启后也按「空闲」还原,不会掉进已完成
    expect(storage.allDispatches().find((d) => d.sessionId === 'sess-timeout')?.lastState).toBe('idle');
  });

  it('未到时间不退出', async () => {
    const { s } = await idleSession('sess-early');
    expect(await sweepIdleDispatches(30, s.lastEventAt + 29 * MIN)).not.toContain('sess-early');
    expect(s.hibernated).toBe(false);
  });

  it('running(回合进行中)不退出', async () => {
    const { s } = await idleSession('sess-running');
    s.send('再来一轮'); // 新回合开始 → working
    expect(s.state).toBe('working');
    expect(await sweepIdleDispatches(10, s.lastEventAt + 999 * MIN)).not.toContain('sess-running');
    expect(s.hibernated).toBe(false);
  });

  it('关闭档(0)不退出', async () => {
    const { s } = await idleSession('sess-off');
    expect(await sweepIdleDispatches(0, s.lastEventAt + 999 * MIN)).toEqual([]);
    expect(s.hibernated).toBe(false);
  });

  it('退出后下一条消息以 --resume 冷启动,沿用原会话 id 与模型', async () => {
    const { s } = await idleSession('sess-resume');
    await s.changeModel('m2');
    await sweepIdleDispatches(10, s.lastEventAt + 10 * MIN);
    await flush();
    expect((await canResume('sess-resume')).ok).toBe(true);
    const before = calls.length;
    s.send('接着做');
    expect(calls.length).toBe(before + 1);
    const opts = calls[calls.length - 1].options;
    expect(opts).toMatchObject({ resume: 'sess-resume', model: 'm2', permissionMode: 'bypassPermissions' });
    expect(opts.forkSession).toBeUndefined();
    expect(s.hibernated).toBe(false);
    expect(s.state).toBe('working');
    // 旧进程迟到的收尾不会把新进程打回 ended
    await flush();
    expect(s.state).toBe('working');
    expect(liveDispatches().find((d) => d.sessionId === 'sess-resume')?.idleExited).toBeUndefined();
  });

  it('设置变更即生效:阈值随每次巡检现读,调短后同一时刻即可命中', async () => {
    const { s } = await idleSession('sess-pref');
    const now = s.lastEventAt + 15 * MIN;
    expect(await sweepIdleDispatches(30, now)).not.toContain('sess-pref');
    expect(await sweepIdleDispatches(10, now)).toContain('sess-pref');
  });

  it('设置项:只接受 关闭/10/30/60/120,默认 30', () => {
    expect(sanitize({}).monitor.idleExit).toBe(30);
    expect(sanitize({ monitor: { idleExit: 0 } }).monitor.idleExit).toBe(0);
    expect(sanitize({ monitor: { idleExit: 45 } }).monitor.idleExit).toBe(30);
  });
});
