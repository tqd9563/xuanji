import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DispatchSession × Artifact 工具开关:
 * Claude Code CLI 按「入口」门控 Artifact 工具(把本地 html 发布成 claude.ai 托管页) ——
 * 入口为 sdk-ts/sdk-py/sdk-cli(含 `claude -p`)或 mcp 时默认不注册该工具,只有交互式终端才有。
 * 璇玑走 SDK query() 正属被门控的入口,必须显式下发 CLAUDE_CODE_ARTIFACT=1 才能与用户终端行为一致。
 * 实测(2.1.259):不设该变量时 init 报文 55 个工具无 Artifact,设了变 56 个并含 Artifact。
 * 注意 `enableArtifact` 设置项与 CLAUDE_CODE_ARTIFACT_TOOLSET 都绕不开这道门,别用它们替代。
 *
 * 这里钉住两件事,防止日后有人整理 env 时顺手删掉:
 * - query() options.env 同时带上 CLAUDE_CODE_ARTIFACT 与 XUANJI_DISPATCH(后者是防自斩标记)
 * - 宿主进程已有的环境变量仍然透传(env 是在 process.env 之上叠加,不是替换)
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

describe('DispatchSession × Artifact 工具开关', () => {
  it('创建会话时下发 CLAUDE_CODE_ARTIFACT=1,让被门控的 SDK 入口也能注册 Artifact 工具', async () => {
    new DispatchSession(tmpStorage(), { cwd: '/tmp/proj' });
    await flush();

    const env = queryCalls[0]?.options.env as Record<string, string> | undefined;
    expect(env?.CLAUDE_CODE_ARTIFACT).toBe('1');
  });

  it('派发身份标记 XUANJI_DISPATCH 不受影响,宿主环境变量照常透传', async () => {
    process.env.XUANJI_ARTIFACT_PROBE = 'kept';
    try {
      new DispatchSession(tmpStorage(), { cwd: '/tmp/proj' });
      await flush();

      const env = queryCalls[0]?.options.env as Record<string, string> | undefined;
      expect(env?.XUANJI_DISPATCH).toBe('1');
      expect(env?.XUANJI_ARTIFACT_PROBE).toBe('kept');
    } finally {
      delete process.env.XUANJI_ARTIFACT_PROBE;
    }
  });
});
