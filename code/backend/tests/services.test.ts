import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heatBuckets } from '../src/services/projects.js';
import { aggregateByModel, costUsd, priceOf, shortModel } from '../src/services/usage.js';
import { Storage } from '../src/storage/db.js';
import type { Memory } from '../src/types.js';

describe('heatBuckets', () => {
  it('近 7 日按项目分桶,今日在末位,范围外丢弃', () => {
    const now = Date.now();
    const day = 86_400_000;
    const buckets = heatBuckets(
      [
        { display: 'a', timestamp: now, project: '/p/a', sessionId: '1' },
        { display: 'b', timestamp: now - 2 * day, project: '/p/a', sessionId: '2' },
        { display: 'c', timestamp: now - 30 * day, project: '/p/a', sessionId: '3' },
      ],
      now,
    );
    const arr = buckets.get('/p/a')!;
    expect(arr[6]).toBe(1);
    expect(arr.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('usage 成本口径', () => {
  it('cost = in×P + cacheWrite×1.25P + cacheRead×0.1P + out×P', () => {
    const r = { model: 'claude-fable-5', input: 1_000_000, cacheCreation: 0, cacheRead: 0, output: 0 };
    expect(costUsd(r)).toBeCloseTo(5);
    const r2 = { model: 'claude-fable-5', input: 0, cacheCreation: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
    expect(costUsd(r2)).toBeCloseTo(5 * 1.25 + 5 * 0.1 + 25);
  });
  it('模型短名与牌价映射', () => {
    expect(shortModel('claude-sonnet-5')).toBe('sonnet');
    expect(priceOf('claude-opus-4-8')).toEqual([5, 25]);
    expect(priceOf('unknown-model')).toEqual([3, 15]); // 保守取 sonnet 档
  });
  it('按模型聚合并按成本排序', () => {
    const agg = aggregateByModel([
      { model: 'claude-sonnet-5', input: 100, cacheCreation: 0, cacheRead: 0, output: 100 },
      { model: 'claude-fable-5', input: 100, cacheCreation: 0, cacheRead: 0, output: 100 },
      { model: 'claude-sonnet-5', input: 50, cacheCreation: 0, cacheRead: 0, output: 0 },
    ]);
    expect(agg[0]!.model).toBe('fable');
    expect(agg.find((m) => m.model === 'sonnet')!.inputTokens).toBe(150);
  });
});

describe('Storage FTS5', () => {
  it('中文 trigram 全文搜索命中 body', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-test-'));
    const storage = new Storage(dir);
    const mem = (name: string, body: string): Memory => ({
      name,
      description: '',
      type: 'project',
      project: 'demo',
      projectPath: '/p/demo',
      file: `/p/demo/${name}.md`,
      body,
      links: [],
    });
    storage.rebuildMemoryIndex([
      mem('a', '上游 SLA 回调在网络抖动时会重复推送同一事件'),
      mem('b', '阈值 0.72 来自 5 月 A/B 验证'),
    ]);
    expect(storage.searchMemories('重复推送')).toEqual(['/p/demo/a.md']);
    expect(storage.searchMemories('0.72')).toEqual(['/p/demo/b.md']);
    expect(storage.searchMemories('不存在的词')).toEqual([]);
    // trigram 最短 3 字符,2 字查询由服务层朴素匹配兜底(此处应返回空)
    expect(storage.searchMemories('阈值')).toEqual([]);
    // 重建幂等
    storage.rebuildMemoryIndex([mem('a', '只有一条')]);
    expect(storage.searchMemories('重复推送')).toEqual([]);
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
