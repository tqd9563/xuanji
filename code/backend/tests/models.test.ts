import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 模型目录(services/models.ts):派发页模型选择器不再写死模型名,候选来自 SDK 的
 * supportedModels()。钉住:
 * - 整理:丢无 value 行、去重、缺显示名用 value 顶、思考档只留字符串;
 * - 落库/回读:重启(进程内缓存清空)后能从 meta 表补回;
 * - 预热:缓存的 CLI 版本与当前一致就不起探测会话;不一致/没缓存才探测并按新版本落库;
 *   探测拿到空目录不覆盖旧缓存;
 * - 派发会话 init 后顺手拉一次并落库;旧 SDK 无该方法时静默跳过、不打断消息泵。
 */

const { makeFakeQuery, fakes, probeModels, versionRef } = vi.hoisted(() => {
  const probeModels: unknown[] = [];
  const versionRef = { v: '2.1.280 (Claude Code)' as string | null };
  function makeFakeQuery() {
    const queue: unknown[] = [];
    const waiters: ((r: IteratorResult<unknown>) => void)[] = [];
    const closed = false;
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
      close: vi.fn(() => {}),
      getContextUsage: vi.fn(async () => ({ percentage: 0 })),
      supportedCommands: vi.fn(async () => []),
      supportedModels: vi.fn(async () => probeModels),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({ rate_limits_available: false })),
    };
    return {
      iterable,
      push: (v: unknown) => {
        const w = waiters.shift();
        if (w) w({ value: v, done: false });
        else queue.push(v);
      },
    };
  }
  return { makeFakeQuery, fakes: [] as ReturnType<typeof makeFakeQuery>[], probeModels, versionRef };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    const f = makeFakeQuery();
    fakes.push(f);
    return f.iterable;
  }),
}));
vi.mock('../src/adapters/notify.js', () => ({ notifyMac: vi.fn() }));
vi.mock('../src/adapters/agents-cli.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/adapters/agents-cli.js')>();
  return { ...orig, cliVersion: vi.fn(async () => versionRef.v), listAgents: vi.fn(async () => []) };
});

const models = await import('../src/services/models.js');
const { DispatchSession } = await import('../src/services/dispatch.js');
const { Storage } = await import('../src/storage/db.js');

const SDK_ROWS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 with 1M context',
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5' },
];

function tmpStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-models-'));
  return new Storage(dir);
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  models.resetModelCatalogForTest();
  probeModels.length = 0;
  versionRef.v = '2.1.280 (Claude Code)';
});
afterEach(() => {
  vi.clearAllMocks();
  fakes.length = 0;
});

describe('normalizeModelCatalog', () => {
  it('丢掉无 value 的行、按 value 去重、缺显示名用 value 顶、思考档只留字符串', () => {
    const out = models.normalizeModelCatalog([
      { value: 'opus', displayName: 'Opus', description: 'x', supportedEffortLevels: ['low', 7, ''] },
      { value: 'opus', displayName: 'dup', description: '' },
      { displayName: 'no value', description: '' },
      { value: ' sonnet ', description: 'trim' },
      'junk',
    ]);
    expect(out).toEqual([
      { value: 'opus', displayName: 'Opus', description: 'x', effortLevels: ['low'] },
      { value: 'sonnet', displayName: 'sonnet', description: 'trim' },
    ]);
  });

  it('非数组输入返回空目录', () => {
    expect(models.normalizeModelCatalog(null)).toEqual([]);
    expect(models.normalizeModelCatalog({ value: 'x' })).toEqual([]);
  });
});

describe('落库与回读', () => {
  it('rememberModelCatalog 后,清掉进程内缓存也能从 meta 表补回(模拟后端重启)', () => {
    const st = tmpStorage();
    models.rememberModelCatalog(st, models.normalizeModelCatalog(SDK_ROWS), '2.1.280 (Claude Code)');
    models.resetModelCatalogForTest();
    const cat = models.cachedModelCatalog(st);
    expect(cat?.cliVersion).toBe('2.1.280 (Claude Code)');
    expect(cat?.models.map((m) => m.value)).toEqual(['default', 'sonnet', 'haiku']);
    expect(cat?.models[0]?.resolvedModel).toBe('claude-opus-5-5[1m]');
  });

  it('空目录不落库、不覆盖既有缓存', () => {
    const st = tmpStorage();
    models.rememberModelCatalog(st, models.normalizeModelCatalog(SDK_ROWS), 'v1');
    models.rememberModelCatalog(st, [], 'v2');
    expect(models.cachedModelCatalog(st)?.cliVersion).toBe('v1');
  });

  it('没缓存时返回 null(接口给空数组,前端走兜底清单)', () => {
    expect(models.cachedModelCatalog(tmpStorage())).toBeNull();
  });
});

describe('warmModelCatalog(启动预热)', () => {
  it('缓存版本与当前 CLI 一致 → hit,不起探测会话', async () => {
    const st = tmpStorage();
    models.rememberModelCatalog(st, models.normalizeModelCatalog(SDK_ROWS), '2.1.280 (Claude Code)');
    expect(await models.warmModelCatalog(st)).toBe('hit');
    expect(fakes.length).toBe(0);
  });

  it('CLI 升级(版本不一致)→ 起空会话探测、按新版本落库并关掉子进程', async () => {
    const st = tmpStorage();
    models.rememberModelCatalog(st, models.normalizeModelCatalog(SDK_ROWS.slice(1)), '2.1.274 (Claude Code)');
    probeModels.push(...SDK_ROWS);
    expect(await models.warmModelCatalog(st)).toBe('refreshed');
    expect(fakes.length).toBe(1);
    expect(fakes[0]!.iterable.close).toHaveBeenCalled();
    const cat = models.cachedModelCatalog(st);
    expect(cat?.cliVersion).toBe('2.1.280 (Claude Code)');
    expect(cat?.models.map((m) => m.value)).toEqual(['default', 'sonnet', 'haiku']);
  });

  it('探测拿到空目录 → failed,旧缓存保留', async () => {
    const st = tmpStorage();
    models.rememberModelCatalog(st, models.normalizeModelCatalog(SDK_ROWS.slice(1)), 'old');
    expect(await models.warmModelCatalog(st)).toBe('failed');
    expect(models.cachedModelCatalog(st)?.cliVersion).toBe('old');
  });
});

describe('DispatchSession × 模型目录', () => {
  it('init 后顺手 supportedModels() 并按当前 CLI 版本落库', async () => {
    const st = tmpStorage();
    probeModels.push(...SDK_ROWS);
    new DispatchSession(st, { cwd: '/tmp/proj' });
    fakes[0]!.push({ type: 'system', subtype: 'init', session_id: 'sid-1', model: 'default' });
    await flush();
    await flush();
    expect(fakes[0]!.iterable.supportedModels).toHaveBeenCalledTimes(1);
    const cat = models.cachedModelCatalog(st);
    expect(cat?.models.map((m) => m.value)).toEqual(['default', 'sonnet', 'haiku']);
    expect(cat?.cliVersion).toBe('2.1.280 (Claude Code)');
  });

  it('旧 SDK 无 supportedModels 时静默跳过,不打断消息泵', async () => {
    const st = tmpStorage();
    const s = new DispatchSession(st, { cwd: '/tmp/proj' });
    delete (fakes[0]!.iterable as Record<string, unknown>).supportedModels;
    const seen: { ev: string; state?: string }[] = [];
    s.subscribe((e) => seen.push(e as never));
    fakes[0]!.push({ type: 'system', subtype: 'init', session_id: 'sid-old', model: 'default' });
    await flush();
    await flush();
    expect(seen.some((e) => e.ev === 'status' && e.state === 'ended')).toBe(false);
    expect(models.cachedModelCatalog(st)).toBeNull();
  });
});
