import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, SessionState } from '../src/types.js';

/** 与归档用例同构的 agents CLI 快照工厂:每轮重新产出对象,避免状态泄漏 */
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
const { Storage } = await import('../src/storage/db.js');

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
/** 用例统一把启用基线钉在 1000,产出时间跨过它才算「新的、待验收的」 */
const BASELINE = 1_000;
const AFTER = 2_000;
const BEFORE = 500;

function session(
  state: SessionState,
  lastOutputAt?: number,
  extra: Partial<AgentSession> = {},
): AgentSession {
  return {
    id: 'aaaaaaaa',
    sessionId: SID,
    name: '会话甲',
    cwd: '/p/demo',
    project: 'demo',
    kind: 'background',
    state,
    startedAt: 1_000,
    readonly: false,
    lastOutputAt,
    ...extra,
  };
}

let dir: string;
let s: InstanceType<typeof Storage>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-review-'));
  s = new Storage(dir);
  s.setMeta('review_baseline_at', String(BASELINE));
});
afterEach(() => {
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('验收中推导', () => {
  it('跑完且有新产出的空闲会话落到验收中', async () => {
    stub = () => [session('idle', AFTER)];
    const board = await sessionsBoard(s);
    expect(board.columns.idle).toHaveLength(0);
    expect(board.columns.review.map((x) => x.sessionId)).toEqual([SID]);
    expect(board.columns.review[0]!.state).toBe('review');
  });

  it('进程已退出(done)的会话同样进验收中——已完成只留给显式归档', async () => {
    stub = () => [session('done', AFTER)];
    const board = await sessionsBoard(s);
    expect(board.columns.done).toHaveLength(0);
    expect(board.columns.review).toHaveLength(1);
  });

  it('产出早于启用基线的历史存量不倒灌进验收中', async () => {
    stub = () => [session('idle', BEFORE)];
    const board = await sessionsBoard(s);
    expect(board.columns.review).toHaveLength(0);
    expect(board.columns.idle).toHaveLength(1);
  });

  it('从未产出过的会话留在空闲,不占验收位', async () => {
    stub = () => [session('idle', undefined)];
    const board = await sessionsBoard(s);
    expect(board.columns.review).toHaveLength(0);
    expect(board.columns.idle).toHaveLength(1);
  });

  it('终端存活的只读会话不进验收中(不是我们的会话,只旁观)', async () => {
    stub = () => [session('idle', AFTER, { readonly: true })];
    const board = await sessionsBoard(s);
    expect(board.columns.review).toHaveLength(0);
    expect(board.columns.idle).toHaveLength(1);
  });

  it('进行态(running/blocked)不受影响', async () => {
    for (const state of ['running', 'blocked'] as const) {
      stub = () => [session(state, AFTER)];
      const board = await sessionsBoard(s);
      expect(board.columns.review).toHaveLength(0);
      expect(board.columns[state]).toHaveLength(1);
    }
  });

  it('已归档的卡不会被重新拉回验收中', async () => {
    s.archiveSession(SID, AFTER);
    stub = () => [session('idle', AFTER)];
    const board = await sessionsBoard(s);
    expect(board.columns.review).toHaveLength(0);
    expect(board.columns.done.map((x) => x.sessionId)).toEqual([SID]);
    expect(board.columns.done[0]!.archived).toBe(true);
  });
});

describe('挂起处置', () => {
  it('挂起后卡片回空闲并标 suspended', async () => {
    s.suspendSession(SID, AFTER);
    stub = () => [session('idle', AFTER)];
    const board = await sessionsBoard(s);
    expect(board.columns.review).toHaveLength(0);
    expect(board.columns.idle.map((x) => x.sessionId)).toEqual([SID]);
    expect(board.columns.idle[0]!.suspended).toBe(true);
  });

  it('已退出(done)的会话挂起后同样落到空闲列', async () => {
    s.suspendSession(SID, AFTER);
    stub = () => [session('done', AFTER)];
    const board = await sessionsBoard(s);
    expect(board.columns.done).toHaveLength(0);
    expect(board.columns.idle).toHaveLength(1);
    expect(board.columns.idle[0]!.state).toBe('idle');
  });

  it('挂起后又有新产出:挂起自动失效,卡片回验收中', async () => {
    s.suspendSession(SID, AFTER);
    stub = () => [session('idle', AFTER + 500)]; // 挂起之后它又说话了
    const board = await sessionsBoard(s);
    expect(board.columns.idle).toHaveLength(0);
    expect(board.columns.review.map((x) => x.sessionId)).toEqual([SID]);
    expect(s.sessionSuspends().size).toBe(0); // 记录已删除,不是每轮重算
  });

  it('手动撤销挂起后回验收中', async () => {
    s.suspendSession(SID, AFTER);
    stub = () => [session('idle', AFTER)];
    expect((await sessionsBoard(s)).columns.idle).toHaveLength(1);
    s.unsuspendSession(SID);
    const after = await sessionsBoard(s);
    expect(after.columns.idle).toHaveLength(0);
    expect(after.columns.review).toHaveLength(1);
  });
});

describe('启用基线', () => {
  it('首次调用钉住并持久化,后续调用返回同一值', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-baseline-'));
    const s2 = new Storage(dir2);
    try {
      const first = s2.reviewBaseline();
      expect(first).toBeGreaterThan(0);
      expect(s2.reviewBaseline()).toBe(first);
      expect(Number(s2.getMeta('review_baseline_at'))).toBe(first);
    } finally {
      s2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
