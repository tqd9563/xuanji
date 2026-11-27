import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, SessionState } from '../src/types.js';

/**
 * 定时任务跑出来的会话不进「会话」看板,只在「定时」页按运行记录查看:
 * - 例外一:卡在审批(blocked)时照常上看板(要人处理);
 * - 例外二:用户续接后亲自发过消息 = 认领,回到看板。
 * 走真实链路:SchedulerService.runNow → createDispatch → 假 SDK 流 init,不手工往表里塞 sessionId。
 */
const { fakes } = vi.hoisted(() => ({ fakes: [] as any[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
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

let stub: () => AgentSession[] = () => [];
vi.mock('../src/adapters/agents-cli.js', () => ({
  listAgents: vi.fn(async () => ({ ok: true, sessions: stub() })),
}));
vi.mock('../src/adapters/claude-dir.js', () => ({
  readJobStates: vi.fn(async () => new Map()),
  findSessionFile: vi.fn(async () => null),
  parseReplay: vi.fn(),
}));

const { sessionsBoard } = await import('../src/services/sessions.js');
const { SchedulerService } = await import('../src/services/scheduler.js');
const { createDispatch, endDispatchBySessionId, findDispatchBySessionId } = await import('../src/services/dispatch.js');
const { Storage } = await import('../src/storage/db.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const SCHED = 'cccccccc-1111-2222-3333-444444444444';
const USER = 'uuuuuuuu-1111-2222-3333-444444444444';

let dir: string;
let s: InstanceType<typeof Storage>;
let sched: InstanceType<typeof SchedulerService>;

const idsOn = (board: Awaited<ReturnType<typeof sessionsBoard>>) =>
  Object.values(board.columns)
    .flat()
    .map((x) => x.sessionId);

/** 让定时任务真跑一期:runNow → 假流 init(拿到 SCHED)→ result,停在 idle */
async function runScheduledOnce() {
  const job = sched.create({ kind: 'cron', name: '每日晨报', prompt: '发晨报', cwd: '/tmp', permissionMode: 'bypassPermissions', cronExpr: '0 10 * * *' });
  sched.runNow(job.id);
  await flush();
  const f = fakes[fakes.length - 1];
  f.push({ type: 'system', subtype: 'init', session_id: SCHED, model: 'm1' });
  await flush();
  f.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {} });
  await flush();
  return { job, fake: f };
}

function cliSession(sessionId: string, state: SessionState): AgentSession {
  return { id: sessionId.slice(0, 8), sessionId, name: 'x', cwd: '/tmp', project: 'tmp', kind: 'background', state, startedAt: 1_000, readonly: false };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-sched-board-'));
  s = new Storage(dir);
  sched = new SchedulerService(s);
  stub = () => [];
});
afterEach(async () => {
  sched.shutdown();
  await endDispatchBySessionId(SCHED);
  await endDispatchBySessionId(USER);
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('定时会话不进会话看板', () => {
  it('跑完一期后:运行记录挂上 sessionId,看板(进程内存活的派发会话)里没有它', async () => {
    const { job } = await runScheduledOnce();
    expect(sched.runs(job.id).runs[0]!.sessionId).toBe(SCHED);
    // 同进程里一个普通派发会话作为对照组:它必须照常在看板上,否则「看不见」可能只是看板整体坏了
    const u = createDispatch(s, { cwd: '/tmp', permissionMode: 'bypassPermissions' });
    u.send('普通对话');
    fakes[fakes.length - 1].push({ type: 'system', subtype: 'init', session_id: USER, model: 'm1' });
    await flush();
    const ids = idsOn(await sessionsBoard(s));
    expect(ids).toContain(USER);
    expect(ids).not.toContain(SCHED);
  });

  it('agents CLI 列出 / 历史派发表补回两条路径同样不展示', async () => {
    await runScheduledOnce();
    await endDispatchBySessionId(SCHED); // 进程内会话没了,只剩 CLI 列表与 dispatches 表
    stub = () => [cliSession(SCHED, 'idle')];
    expect(idsOn(await sessionsBoard(s))).not.toContain(SCHED);
    stub = () => [];
    expect(s.allDispatches().map((d) => d.sessionId)).toContain(SCHED); // 确认走到的是历史补回分支
    expect(idsOn(await sessionsBoard(s))).not.toContain(SCHED);
  });

  it('卡在审批时照常上看板,并标 scheduled', async () => {
    await runScheduledOnce();
    await endDispatchBySessionId(SCHED);
    stub = () => [cliSession(SCHED, 'blocked')];
    const board = await sessionsBoard(s);
    expect(board.columns.blocked.map((x) => x.sessionId)).toEqual([SCHED]);
    expect(board.columns.blocked[0]!.scheduled).toBe(true);
  });

  it('定时任务自己那条 prompt 不算认领;用户接回后发一条消息即回到看板', async () => {
    await runScheduledOnce();
    expect(s.scheduledOnlySessionIds().has(SCHED)).toBe(true);
    // 用户从定时页 attach 回原会话接着聊(init 之后,sessionId 已知)
    findDispatchBySessionId(SCHED)!.send('再补充一下周报');
    expect(s.scheduledOnlySessionIds().has(SCHED)).toBe(false);
    const board = await sessionsBoard(s);
    const card = Object.values(board.columns).flat().find((x) => x.sessionId === SCHED);
    expect(card).toBeDefined();
    expect(card!.scheduled).toBeUndefined();
  });

  it('进程已退出后 --resume 续接:首条消息在 init 之前,也按 resumeFrom 归属而认领', async () => {
    await runScheduledOnce();
    await endDispatchBySessionId(SCHED);
    const r = createDispatch(s, { cwd: '/tmp', permissionMode: 'bypassPermissions', resume: SCHED });
    r.send('接着做');
    expect(s.scheduledOnlySessionIds().has(SCHED)).toBe(false);
    await r.end();
  });

  it('分叉续接(fork)的首条消息不归到原会话', async () => {
    await runScheduledOnce();
    await endDispatchBySessionId(SCHED);
    const r = createDispatch(s, { cwd: '/tmp', permissionMode: 'bypassPermissions', resume: SCHED, fork: true });
    r.send('分叉出去做');
    expect(s.scheduledOnlySessionIds().has(SCHED)).toBe(true);
    await r.end();
  });
});
