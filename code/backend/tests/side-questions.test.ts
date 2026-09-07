import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 旁路提问(/btw):
 * - CLI 自己不落盘 side question(实测 ~/.claude 下没有任何 side_question 痕迹),「问过的一定还在」由自有库兑现;
 * - DispatchSession.askSideQuestion 走 SDK 未公开声明的 askSideQuestion(sdk.mjs 0.3.258 实装),
 *   三段式事件 btw-start → btw-result / btw-error,答案不进主对话事件流(没有 assistant/delta);
 * - 「存为经验」写 memory 是铁律 2 的例外①,落项目 memory 目录并追加 MEMORY.md 索引,同名不覆盖。
 */

const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-btw-claude-'));
process.env.XUANJI_CLAUDE_DIR = claudeDir;

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
    const askSideQuestion = vi.fn(
      async (_q: string, _o?: { signal?: AbortSignal }): Promise<{ response: string; synthetic: boolean } | null> => ({
        response: '答案',
        synthetic: false,
      }),
    );
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
      askSideQuestion,
    };
    return { iterable, push, askSideQuestion, close: () => (closed = true) };
  }
  return { makeFakeQuery, fakes: [] as ReturnType<typeof makeFakeQuery>[] };
});

const queryMock = vi.fn((_args: { options: Record<string, unknown> }) => {
  const f = makeFakeQuery();
  fakes.push(f);
  return f.iterable;
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../src/adapters/notify.js', () => ({ notifyMac: vi.fn() }));

const { DispatchSession } = await import('../src/services/dispatch.js');
const { Storage } = await import('../src/storage/db.js');
const { writeMemory, encodeProjectDir } = await import('../src/services/memories.js');

function tmpStorage() {
  return new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-btw-')));
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('side_questions 存储', () => {
  it('按会话记录并按时间正序取回;memory 路径可回填', () => {
    const st = tmpStorage();
    const a = st.recordSideQuestion({ sessionId: 's1', question: 'q1', answer: 'a1' });
    const b = st.recordSideQuestion({ sessionId: 's1', question: 'q2', answer: 'a2', synthetic: true });
    st.recordSideQuestion({ sessionId: 's2', question: 'other', answer: 'x' });
    expect(st.listSideQuestions('s1').map((r) => r.question)).toEqual(['q1', 'q2']);
    expect(st.listSideQuestions('s1')[1]!.synthetic).toBe(true);
    expect(a.memoryFile).toBeNull();
    st.markSideQuestionMemory(a.id, '/m/a.md');
    expect(st.getSideQuestion(a.id)?.memoryFile).toBe('/m/a.md');
    expect(st.getSideQuestion(b.id)?.memoryFile).toBeNull();
    expect(st.getSideQuestion(9999)).toBeNull();
  });
});

describe('DispatchSession.askSideQuestion', () => {
  afterEach(() => {
    fakes.length = 0;
  });

  async function ready() {
    const st = tmpStorage();
    const s = new DispatchSession(st, { cwd: '/p' });
    const events: { ev: string }[] = [];
    s.subscribe((e) => events.push(e));
    const f = fakes[0]!;
    f.push({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm' });
    await flush();
    return { st, s, f, events };
  }

  it('会话未 init 时直接报错,不碰 SDK', async () => {
    const st = tmpStorage();
    const s = new DispatchSession(st, { cwd: '/p' });
    const events: { ev: string }[] = [];
    s.subscribe((e) => events.push(e));
    await s.askSideQuestion('早了');
    expect(events.map((e) => e.ev)).toEqual(['btw-error']);
    expect(fakes[0]!.askSideQuestion).not.toHaveBeenCalled();
  });

  it('start → result:答案落库,主对话事件流里没有 assistant/delta', async () => {
    const { st, s, f, events } = await ready();
    events.length = 0;
    await s.askSideQuestion('顺便问一句');
    expect(f.askSideQuestion).toHaveBeenCalledWith('顺便问一句', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(events.map((e) => e.ev)).toEqual(['btw-start', 'btw-result']);
    const result = events[1] as { ev: 'btw-result'; record: { answer: string; sessionId: string; route: string } };
    expect(result.record).toMatchObject({ answer: '答案', sessionId: 'sess-1', route: 'direct' });
    expect(st.listSideQuestions('sess-1')).toHaveLength(1);
    expect(events.some((e) => e.ev === 'assistant' || e.ev === 'delta')).toBe(false);
    expect(s.sideQuestionInFlight).toBe(false);
  });

  it('SDK 返回 null(取消)→ btw-error 且不落库;并发第二问被拒', async () => {
    const { st, s, f, events } = await ready();
    let release!: () => void;
    f.askSideQuestion.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(null))),
    );
    events.length = 0;
    const p = s.askSideQuestion('第一问');
    await flush();
    expect(s.sideQuestionInFlight).toBe(true);
    await s.askSideQuestion('第二问');
    release();
    await p;
    const evs = events.map((e) => e.ev);
    expect(evs).toEqual(['btw-start', 'btw-error', 'btw-error']);
    expect(st.listSideQuestions('sess-1')).toHaveLength(0);
  });

  it('SDK 抛错 → btw-error 带原文,句柄恢复可再问', async () => {
    const { s, f, events } = await ready();
    f.askSideQuestion.mockRejectedValueOnce(new Error('boom'));
    events.length = 0;
    await s.askSideQuestion('会炸');
    expect(events[1]).toMatchObject({ ev: 'btw-error', message: 'boom' });
    await s.askSideQuestion('再来');
    expect(events.at(-1)?.ev).toBe('btw-result');
  });
});

describe('writeMemory(存为经验)', () => {
  beforeAll(() => {
    fs.mkdirSync(claudeDir, { recursive: true });
  });

  it('项目路径编码与 CLI 一致', () => {
    expect(encodeProjectDir('/Users/x/a.b/c')).toBe('-Users-x-a-b-c');
  });

  it('落项目 memory 目录 + 追加索引;同名不覆盖', async () => {
    const f1 = await writeMemory({ cwd: '/p/demo', name: 'wall glass 区别', description: 'wall-on 与 wall-glass', type: 'reference', body: '正文' });
    const memDir = path.join(claudeDir, 'projects', '-p-demo', 'memory');
    expect(path.dirname(f1)).toBe(memDir);
    const md = fs.readFileSync(f1, 'utf8');
    expect(md).toMatch(/^---\nname: wall-glass-区别\n/);
    expect(md).toContain('type: reference');
    expect(md.trim().endsWith('正文')).toBe(true);
    const f2 = await writeMemory({ cwd: '/p/demo', name: 'wall glass 区别', description: 'd2', type: 'reference', body: 'b2' });
    expect(f2).not.toBe(f1);
    expect(fs.readFileSync(f1, 'utf8')).toContain('正文');
    const index = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
    expect(index.startsWith('# Memory Index')).toBe(true);
    expect(index.split('\n').filter((l) => l.startsWith('- [')).length).toBe(2);
  });
});
