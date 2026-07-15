import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 派发通道打桩:SchedulerService 只关心 subscribe/send 契约,不真的跑 Agent SDK 子进程 */
const { sessions, FakeSession } = vi.hoisted(() => {
  class FakeSession {
    id = Math.random().toString(36).slice(2);
    private listeners: Array<(e: Record<string, unknown>) => void> = [];
    subscribe(l: (e: Record<string, unknown>) => void) {
      this.listeners.push(l);
      return () => {
        this.listeners = this.listeners.filter((x) => x !== l);
      };
    }
    send(_text: string) {}
    emit(e: Record<string, unknown>) {
      for (const l of [...this.listeners]) l(e);
    }
  }
  return { sessions: [] as InstanceType<typeof FakeSession>[], FakeSession };
});

vi.mock('../src/services/dispatch.js', () => ({
  createDispatch: vi.fn(() => {
    const s = new FakeSession();
    sessions.push(s);
    return s;
  }),
}));
vi.mock('../src/adapters/notify.js', () => ({ notifyMac: vi.fn() }));

const { SchedulerService } = await import('../src/services/scheduler.js');
const { Storage } = await import('../src/storage/db.js');

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-sched-'));
  return new Storage(dir);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.clearAllMocks();
  sessions.length = 0;
});

describe('SchedulerService.create', () => {
  it('一次性任务:pending 状态,nextRunAt = runAt', () => {
    const sched = new SchedulerService(tmpStorage());
    const runAt = Date.now() + 3_600_000;
    const job = sched.create({ kind: 'once', name: 't1', prompt: 'p', cwd: '/tmp', permissionMode: 'default', runAt });
    expect(job.status).toBe('pending');
    expect(job.nextRunAt).toBe(runAt);
    sched.shutdown();
  });

  it('周期任务:计算出未来的 nextRunAt', () => {
    const sched = new SchedulerService(tmpStorage());
    const job = sched.create({ kind: 'cron', name: 't2', prompt: 'p', cwd: '/tmp', permissionMode: 'default', cronExpr: '0 9 * * *' });
    expect(job.status).toBe('pending');
    expect(job.nextRunAt).toBeGreaterThan(Date.now());
    sched.shutdown();
  });

  it('once 缺 runAt / cron 缺 cronExpr 拒绝创建', () => {
    const sched = new SchedulerService(tmpStorage());
    expect(() => sched.create({ kind: 'once', name: 'x', prompt: 'p', cwd: '/tmp', permissionMode: 'default' })).toThrow();
    expect(() => sched.create({ kind: 'cron', name: 'x', prompt: 'p', cwd: '/tmp', permissionMode: 'default' })).toThrow();
    sched.shutdown();
  });
});

describe('SchedulerService.fire 生命周期', () => {
  it('runNow → init → result:一次性任务转 done,run history 记成本/耗时', async () => {
    const sched = new SchedulerService(tmpStorage());
    const job = sched.create({ kind: 'once', name: 't3', prompt: 'p', cwd: '/tmp', permissionMode: 'default', runAt: Date.now() + 3_600_000 });
    sched.runNow(job.id);
    await flush();
    expect(sessions).toHaveLength(1);
    sessions[0]!.emit({ ev: 'init', sessionId: 'sess-abc' });
    sessions[0]!.emit({ ev: 'result', costUsd: 1.2, durationMs: 5000 });
    await flush();

    const fresh = sched.get(job.id)!;
    expect(fresh.status).toBe('done');
    expect(fresh.resultSessionId).toBe('sess-abc');

    const { runs } = sched.runs(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'done', costUsd: 1.2, durationMs: 5000, sessionId: 'sess-abc' });
    sched.shutdown();
  });

  it('error 事件:一次性任务转 error 并记录 lastError', async () => {
    const sched = new SchedulerService(tmpStorage());
    const job = sched.create({ kind: 'once', name: 't3b', prompt: 'p', cwd: '/tmp', permissionMode: 'default', runAt: Date.now() + 3_600_000 });
    sched.runNow(job.id);
    await flush();
    sessions[0]!.emit({ ev: 'error', message: 'boom' });
    await flush();
    const fresh = sched.get(job.id)!;
    expect(fresh.status).toBe('error');
    expect(fresh.lastError).toBe('boom');
    sched.shutdown();
  });

  it('awaiting-permission:任务与运行行都标 blocked', async () => {
    const sched = new SchedulerService(tmpStorage());
    const job = sched.create({ kind: 'once', name: 't6', prompt: 'p', cwd: '/tmp', permissionMode: 'default', runAt: Date.now() + 3_600_000 });
    sched.runNow(job.id);
    await flush();
    sessions[0]!.emit({ ev: 'status', state: 'awaiting-permission' });
    await flush();
    expect(sched.get(job.id)!.status).toBe('blocked');
    expect(sched.runs(job.id).runs[0]!.status).toBe('blocked');
    sched.shutdown();
  });

  it('周期任务连续失败 3 次熔断,停止调度', async () => {
    const sched = new SchedulerService(tmpStorage());
    const job = sched.create({ kind: 'cron', name: 't4', prompt: 'p', cwd: '/tmp', permissionMode: 'default', cronExpr: '0 9 * * *' });
    for (let i = 0; i < 3; i++) {
      sched.runNow(job.id);
      await flush();
      sessions[sessions.length - 1]!.emit({ ev: 'error', message: `boom ${i}` });
      await flush();
    }
    const fresh = sched.get(job.id)!;
    expect(fresh.status).toBe('fused');
    expect(fresh.consecutiveFailures).toBe(3);
    sched.shutdown();
  });

  it('周期任务成功后清零失败计数并回到 pending', async () => {
    const sched = new SchedulerService(tmpStorage());
    const job = sched.create({ kind: 'cron', name: 't5', prompt: 'p', cwd: '/tmp', permissionMode: 'default', cronExpr: '0 9 * * *' });
    sched.runNow(job.id);
    await flush();
    sessions[0]!.emit({ ev: 'error', message: 'e1' });
    await flush();
    expect(sched.get(job.id)!.consecutiveFailures).toBe(1);

    sched.runNow(job.id);
    await flush();
    sessions[1]!.emit({ ev: 'result', costUsd: 0.5, durationMs: 1000 });
    await flush();
    const fresh = sched.get(job.id)!;
    expect(fresh.status).toBe('pending');
    expect(fresh.consecutiveFailures).toBe(0);
    sched.shutdown();
  });

  it('超预算:result 到达但成本超上限 → 运行记为 done 附超预算说明,并弹通知', async () => {
    const sched = new SchedulerService(tmpStorage());
    const job = sched.create({
      kind: 'once', name: 't7', prompt: 'p', cwd: '/tmp', permissionMode: 'default',
      runAt: Date.now() + 3_600_000, maxBudgetUsd: 1,
    });
    sched.runNow(job.id);
    await flush();
    sessions[0]!.emit({ ev: 'result', costUsd: 5, durationMs: 1000 });
    await flush();
    const { runs } = sched.runs(job.id);
    expect(runs[0]!.status).toBe('done');
    expect(runs[0]!.error).toMatch(/超预算/);
    sched.shutdown();
  });
});

describe('SchedulerService 状态机', () => {
  it('pause/resume(周期)、cancel(一次性)、remove', () => {
    const sched = new SchedulerService(tmpStorage());
    const cronJob = sched.create({ kind: 'cron', name: 'c1', prompt: 'p', cwd: '/tmp', permissionMode: 'default', cronExpr: '0 9 * * *' });
    expect(sched.pause(cronJob.id)).toBe(true);
    expect(sched.get(cronJob.id)!.status).toBe('paused');
    expect(sched.resume(cronJob.id)).toBe(true);
    expect(sched.get(cronJob.id)!.status).toBe('pending');

    const onceJob = sched.create({ kind: 'once', name: 'o1', prompt: 'p', cwd: '/tmp', permissionMode: 'default', runAt: Date.now() + 3_600_000 });
    expect(sched.pause(onceJob.id)).toBe(false); // 一次性任务不可暂停
    expect(sched.cancel(onceJob.id)).toBe(true);
    expect(sched.get(onceJob.id)!.status).toBe('canceled');

    sched.remove(onceJob.id);
    expect(sched.get(onceJob.id)).toBeNull();
    sched.shutdown();
  });

  it('运行期间用户取消:onOutcome 不覆盖已取消状态', async () => {
    const sched = new SchedulerService(tmpStorage());
    const job = sched.create({ kind: 'once', name: 't8', prompt: 'p', cwd: '/tmp', permissionMode: 'default', runAt: Date.now() + 3_600_000 });
    sched.runNow(job.id);
    await flush();
    sched.cancel(job.id); // 会话仍在跑,但用户已取消
    sessions[0]!.emit({ ev: 'result', costUsd: 0.1, durationMs: 100 });
    await flush();
    expect(sched.get(job.id)!.status).toBe('canceled');
    sched.shutdown();
  });
});

describe('睡眠错过追赶策略', () => {
  it('init() 加载时发现 pending 任务的 runAt 早于宽限窗口 → 直接标 missed,不触发派发', () => {
    const storage = tmpStorage();
    storage.createScheduledJob({
      id: 'old-job', kind: 'once', name: 'old', prompt: 'p', cwd: '/tmp', model: null,
      permissionMode: 'default', maxBudgetUsd: null, runAt: Date.now() - 3_600_000, cronExpr: null,
      status: 'pending', consecutiveFailures: 0, resultSessionId: null, lastError: null, nextRunAt: null,
    });
    const sched = new SchedulerService(storage);
    sched.init();
    expect(sched.get('old-job')!.status).toBe('missed');
    expect(sessions).toHaveLength(0); // 未创建任何派发会话
    sched.shutdown();
  });

  it('init() 加载 runAt 在宽限窗口内的 pending 任务 → 立即补跑', async () => {
    const storage = tmpStorage();
    storage.createScheduledJob({
      id: 'catchup-job', kind: 'once', name: 'catchup', prompt: 'p', cwd: '/tmp', model: null,
      permissionMode: 'default', maxBudgetUsd: null, runAt: Date.now() - 5 * 60_000, cronExpr: null,
      status: 'pending', consecutiveFailures: 0, resultSessionId: null, lastError: null, nextRunAt: null,
    });
    const sched = new SchedulerService(storage);
    sched.init();
    // 立即补跑走 setTimeout(fn, 0),不经过 croner(其 Date 触发器秒级精度,贴近当下会漏触发)
    await flush();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    sched.shutdown();
  });
});
