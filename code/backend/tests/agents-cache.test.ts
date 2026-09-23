/**
 * listAgents 缓存的对象所有权契约(2026-08-05 回归)。
 *
 * sessionsBoard 会原地改写卡片状态(归档 → done、验收中 → review)。缓存若把同一批对象
 * 交给多次调用,TTL 内的第二次轮询就会拿到「已被上一轮改过状态」的卡,主循环按 s.state
 * 直接分列,跳过归档/挂起覆盖——实测表现为挂起后卡片纹丝不动。故缓存必须按次发副本。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const RAW = [
  {
    id: 'aaaaaaaa',
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    cwd: '/p/demo',
    kind: 'background',
    startedAt: 1_000,
    state: 'idle',
  },
];

// promisify(execFile) 走 callback 约定:最后一个参数是 (err, stdout, stderr)
execFileMock.mockImplementation((...args: unknown[]) => {
  const cb = args[args.length - 1] as (e: unknown, o: { stdout: string; stderr: string }) => void;
  cb(null, { stdout: JSON.stringify(RAW), stderr: '' });
});

const { listAgents } = await import('../src/adapters/agents-cli.js');

afterEach(() => {
  execFileMock.mockClear();
});

describe('listAgents 缓存', () => {
  it('TTL 内命中缓存(不重复拉起子进程),但每次返回互不共享的副本', async () => {
    const a = await listAgents();
    const b = await listAgents();

    // 缓存生效:子进程只拉起一次
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(b.sessions).toHaveLength(1);

    // 关键契约:两次拿到的不是同一个对象
    expect(b.sessions[0]).not.toBe(a.sessions[0]);

    // 改写第一次的结果,不得污染后续调用
    a.sessions[0]!.state = 'review';
    a.sessions[0]!.name = '被改过的名字';
    const c = await listAgents();
    expect(c.sessions[0]!.state).toBe('idle');
    expect(c.sessions[0]!.name).not.toBe('被改过的名字');
  });
});

describe('listAgents 并发合流', () => {
  it('缓存未命中时同刻到达的两次调用只拉起一个子进程,且各自拿到副本', async () => {
    // 独立一份模块:上面的用例已把缓存喂热,这里要的是「冷缓存 + 并发」
    vi.resetModules();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string; stderr: string }) => void;
      setTimeout(() => cb(null, { stdout: JSON.stringify(RAW), stderr: '' }), 20); // 让两次调用真的重叠
    });
    const { listAgents: fresh } = await import('../src/adapters/agents-cli.js');
    const [a, b] = await Promise.all([fresh(), fresh()]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(a.sessions).toEqual(b.sessions);
    expect(a.sessions[0]).not.toBe(b.sessions[0]);
  });
});
