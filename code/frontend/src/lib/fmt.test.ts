/** 用量数值格式化:仪表盘用量模块的成本/token 双口径切换直接依赖它 */
import { describe, expect, it } from 'vitest';
import { fmtCost, fmtTokens } from './utils';

describe('fmtTokens 量级分档', () => {
  it('十亿档走 B 并保两位小数(近一周量级,一位小数分不出高低)', () => {
    expect(fmtTokens(1_420_000_000)).toBe('1.42B');
    expect(fmtTokens(11_200_000_000)).toBe('11.20B');
  });
  it('百万档 M、千档 k、以下原样', () => {
    expect(fmtTokens(214_600_000)).toBe('214.6M');
    expect(fmtTokens(48_900)).toBe('48.9k');
    expect(fmtTokens(600)).toBe('600');
    expect(fmtTokens(0)).toBe('0');
  });
  it('档位边界正好切换', () => {
    expect(fmtTokens(999_999_999)).toBe('1000.0M'); // 未到 1e9 仍走 M 档
    expect(fmtTokens(1_000_000_000)).toBe('1.00B');
    expect(fmtTokens(1_000_000)).toBe('1.0M');
    expect(fmtTokens(1_000)).toBe('1.0k');
  });
});

describe('fmtCost', () => {
  it('美元两位小数', () => {
    expect(fmtCost(3.121)).toBe('$3.12');
    expect(fmtCost(0)).toBe('$0.00');
  });
});
