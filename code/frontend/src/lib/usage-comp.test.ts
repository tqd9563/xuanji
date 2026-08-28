/** token 四分量拆解:仪表盘用量模块「构成(开发侧)」直接依赖它 */
import { describe, expect, it } from 'vitest';
import type { ModelUsage } from '@/api/types';
import { CACHE_READ_WEIGHT, sumComp } from './utils';

const m = (p: Partial<ModelUsage>): ModelUsage => ({
  model: 'fable',
  inputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  ...p,
});

describe('sumComp 四分量汇总', () => {
  it('跨模型逐项相加,四类各归各位', () => {
    const c = sumComp([
      m({ model: 'fable', inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 4000 }),
      m({ model: 'sonnet', inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 40 }),
    ]);
    expect(c).toEqual({ input: 101, output: 202, cacheWrite: 303, cacheRead: 4040 });
  });

  it('空列表给全零,不是 NaN(项目当日无用量时展开不能显示 NaN)', () => {
    expect(sumComp([])).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  });

  it('前三项之和 = 报表的 inOut 口径(条长与构成必须对得上)', () => {
    const list = [m({ inputTokens: 7, outputTokens: 11, cacheCreationTokens: 13, cacheReadTokens: 9999 })];
    const c = sumComp(list);
    expect(c.input + c.output + c.cacheWrite).toBe(31);
    // cacheRead 被排除在 inOut 之外,故不参与上式
    expect(c.cacheRead).toBe(9999);
  });

  it('cacheRead 计费折算权重与后端 costUsd 同源(0.1×input)', () => {
    expect(CACHE_READ_WEIGHT).toBe(0.1);
    expect(sumComp([m({ cacheReadTokens: 439_500_000 })]).cacheRead * CACHE_READ_WEIGHT).toBe(43_950_000);
  });
});
