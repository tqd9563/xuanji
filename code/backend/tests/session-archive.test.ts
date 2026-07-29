import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, SessionState } from '../src/types.js';

/**
 * 每个用例自定的 agents CLI 快照:模拟会话真实推导态的变化。
 * 用工厂而非固定数组——真实 listAgents 每次重新解析 JSON 产出全新对象,
 * 复用同一对象会让上一轮的状态覆盖泄漏到下一轮,掩盖真实行为。
 */
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

function session(state: SessionState, lastOutputAt?: number): AgentSession {
  return {
    id: 'aaaaaaaa',
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    name: '会话甲',
    cwd: '/p/demo',
    project: 'demo',
    kind: 'background',
    state,
    startedAt: 1_000,
    readonly: false,
    lastOutputAt,
  };
}

let dir: string;
let s: InstanceType<typeof Storage>;
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-archive-'));
  s = new Storage(dir);
});
afterEach(() => {
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('手动归档覆盖', () => {
  it('归档后空闲卡搬到已完成列并标 archived', async () => {
    stub = () => [session('idle', 500)]; 
    s.archiveSession(SID, 500);
    const board = await sessionsBoard(s);
    expect(board.columns.idle).toHaveLength(0);
    expect(board.columns.done.map((x) => x.sessionId)).toEqual([SID]);
    expect(board.columns.done[0]!.state).toBe('done');
    expect(board.columns.done[0]!.archived).toBe(true);
  });

  it('会话重新跑起来(running/blocked)时归档自动失效', async () => {
    for (const state of ['running', 'blocked'] as const) {
      s.archiveSession(SID, 500);
      stub = () => [session(state, 500)];
      const board = await sessionsBoard(s);
      expect(board.columns.done).toHaveLength(0);
      expect(board.columns[state].map((x) => x.sessionId)).toEqual([SID]);
      expect(s.sessionArchives().size).toBe(0); // 记录已删除,不是每轮重算
    }
  });

  it('轮询间隙里聊过又回到空闲:lastOutputAt 前进,归档同样失效', async () => {
    s.archiveSession(SID, 500);
    stub = () => [session('idle', 900)]; // 归档后又有新产出
    const board = await sessionsBoard(s);
    expect(board.columns.done).toHaveLength(0);
    expect(board.columns.idle.map((x) => x.sessionId)).toEqual([SID]);
    expect(s.sessionArchives().size).toBe(0);
  });

  it('产出时间未变则归档保持,撤销后回归推导态', async () => {
    s.archiveSession(SID, 500);
    stub = () => [session('idle', 500)]; 
    expect((await sessionsBoard(s)).columns.done).toHaveLength(1);
    s.unarchiveSession(SID);
    const after = await sessionsBoard(s);
    expect(after.columns.done).toHaveLength(0);
    expect(after.columns.idle).toHaveLength(1);
  });

  it('本身已是 done 的会话归档后不重复出现', async () => {
    s.archiveSession(SID, 500);
    stub = () => [session('done', 500)]; 
    const board = await sessionsBoard(s);
    expect(board.columns.done).toHaveLength(1);
    expect(board.columns.done[0]!.archived).toBe(true);
  });
});
