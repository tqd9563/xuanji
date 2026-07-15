import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../src/types.js';

// closedSessions 的 agents CLI 依赖打桩:终端来源会话的元数据补全路径
vi.mock('../src/adapters/agents-cli.js', () => ({
  listAgents: vi.fn(async () => ({
    ok: true,
    sessions: [
      { sessionId: 'term-1', name: '终端会话甲', cwd: '/p/demo' } as AgentSession,
      { sessionId: 'term-2', name: '别的项目', cwd: '/p/other' } as AgentSession,
    ],
  })),
}));

const { closedSessions } = await import('../src/services/sessions.js');
const { Storage } = await import('../src/storage/db.js');

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-closed-'));
  return { dir, s: new Storage(dir) };
}

afterEach(() => vi.clearAllMocks());

describe('Storage 隐藏列表往返', () => {
  it('hideSession → hiddenSessions 读回 → unhideSession 移除', () => {
    const { dir, s } = tmpStorage();
    s.hideSession('sid-1');
    s.hideSession('sid-1'); // 幂等
    expect(s.hiddenSessions().map((r) => r.sessionId)).toEqual(['sid-1']);
    expect(s.hiddenSessions()[0]!.hiddenAt).toBeGreaterThan(0);
    s.unhideSession('sid-1');
    expect(s.hiddenSessionIds().size).toBe(0);
    s.unhideSession('sid-1'); // 不存在时静默
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('closedSessions /resume 弹窗数据源', () => {
  it('dispatches 表优先、agents 补全、改名覆盖、cwd 过滤、无元数据不展示', async () => {
    const { dir, s } = tmpStorage();
    // web 派发的隐藏会话(dispatches 有记录)
    s.recordDispatch('web-1', '/p/demo', 'web 会话');
    s.hideSession('web-1');
    // 终端来源的隐藏会话(仅 agents CLI 知道)
    s.hideSession('term-1');
    // 其他项目的隐藏会话
    s.hideSession('term-2');
    // 元数据不可寻的隐藏会话
    s.hideSession('ghost-1');
    // display-name 覆盖
    s.setSessionName('web-1', '改名后');

    const demo = await closedSessions(s, '/p/demo');
    expect(demo.map((r) => r.sessionId).sort()).toEqual(['term-1', 'web-1']);
    expect(demo.find((r) => r.sessionId === 'web-1')!.name).toBe('改名后');
    expect(demo.find((r) => r.sessionId === 'term-1')!.name).toBe('终端会话甲');
    expect(demo[0]!.project).toBe('demo');

    const all = await closedSessions(s);
    expect(all).toHaveLength(3); // ghost-1 无元数据,不展示
    expect(all.map((r) => r.sessionId)).not.toContain('ghost-1');
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
