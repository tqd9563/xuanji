import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, SessionState } from '../src/types.js';

/** 每个用例自定的 agents CLI 快照:模拟会话从存活到消失的过程 */
let stub: () => AgentSession[] = () => [];

vi.mock('../src/adapters/agents-cli.js', () => ({
  listAgents: vi.fn(async () => ({ ok: true, sessions: stub() })),
}));
vi.mock('../src/adapters/claude-dir.js', () => ({
  readJobStates: vi.fn(async () => new Map()),
  findSessionFile: vi.fn(async () => null),
  parseReplay: vi.fn(),
}));

const { sessionsBoard, usageNameResolver } = await import('../src/services/sessions.js');
const { Storage } = await import('../src/storage/db.js');

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

function session(name: string, state: SessionState = 'running'): AgentSession {
  return {
    id: SID.slice(0, 8),
    sessionId: SID,
    name,
    cwd: '/p/demo',
    project: 'demo',
    kind: 'interactive',
    state,
    startedAt: 1_000,
    readonly: true,
  };
}

let dir: string;
let s: InstanceType<typeof Storage>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-title-'));
  s = new Storage(dir);
});
afterEach(() => {
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('会话名快照', () => {
  it('看板轮询时记下会话名,会话消失后仍能解析出名字', async () => {
    stub = () => [session('终端界面调研')];
    await sessionsBoard(s);
    expect(s.sessionTitleSnapshots().get(SID)).toBe('终端界面调研');

    stub = () => []; // 会话进程退出,agents CLI 不再列出
    const board = await sessionsBoard(s);
    expect(usageNameResolver(board, s)(SID)).toBe('终端界面调研');
  });

  it('8 位 id 占位名不入快照,也不会盖掉已记下的真名', async () => {
    stub = () => [session(SID.slice(0, 8))];
    await sessionsBoard(s);
    expect(s.sessionTitleSnapshots().has(SID)).toBe(false);

    stub = () => [session('真名')];
    await sessionsBoard(s);
    stub = () => [session(SID.slice(0, 8))];
    const board = await sessionsBoard(s);
    expect(usageNameResolver(board, s)(SID)).toBe('真名');
  });

  it('改名后快照跟着更新', async () => {
    stub = () => [session('旧名')];
    await sessionsBoard(s);
    stub = () => [session('新名')];
    await sessionsBoard(s);
    expect(s.sessionTitleSnapshots().get(SID)).toBe('新名');
  });
});

describe('用量报表会话名解析', () => {
  it('用户重命名覆盖优先级最高,盖过看板名与快照', async () => {
    stub = () => [session('看板名')];
    await sessionsBoard(s);
    s.setSessionName(SID, '我改的名');
    const board = await sessionsBoard(s);
    expect(usageNameResolver(board, s)(SID)).toBe('我改的名');
  });

  it('已退出的 web 派发会话取派发注册表里的名字', async () => {
    stub = () => [];
    s.recordDispatch(SID, '/p/demo', '派发任务甲');
    const board = await sessionsBoard(s);
    expect(usageNameResolver(board, s)(SID)).toBe('派发任务甲');
  });

  it('完全不认识的会话返回 undefined(由 usage 层退化成转录首句)', async () => {
    stub = () => [];
    const board = await sessionsBoard(s);
    expect(usageNameResolver(board, s)('ffffffff-0000-0000-0000-000000000000')).toBeUndefined();
  });
});
