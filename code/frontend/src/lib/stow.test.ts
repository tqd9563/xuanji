import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL, loadLocal } from '@/lib/prefs';
import { STOW_OPTS, recentOf, stowLabel } from '@/lib/stow';

describe('收纳列展示条数', () => {
  it('两列各读自己的偏好', () => {
    const p = { stowIdle: 3, stowDone: 10 } as const;
    expect(recentOf('idle', p)).toBe(3);
    expect(recentOf('done', p)).toBe(10);
  });

  it('0 档 = 全部:切片与「更早的 N 条」自然退化', () => {
    const p = { stowIdle: 0, stowDone: 5 } as const;
    const n = recentOf('idle', p);
    const items = [1, 2, 3, 4, 5, 6];
    expect(items.slice(0, n)).toEqual(items);
    expect(items.slice(n)).toEqual([]);
    expect(Math.max(0, items.length - n)).toBe(0);
  });

  it('默认两列都是 5 张', () => {
    expect(DEFAULT_LOCAL.stowIdle).toBe(5);
    expect(DEFAULT_LOCAL.stowDone).toBe(5);
    expect(recentOf('idle', DEFAULT_LOCAL)).toBe(5);
  });

  it('非法值回落默认,不会渲染出 0 张或 NaN', () => {
    // 测试环境是 node,没有 localStorage:只给 loadLocal 需要的 getItem
    const raw = JSON.stringify({ stowIdle: 7, stowDone: 'many' });
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => raw };
    try {
      const p = loadLocal();
      expect(p.stowIdle).toBe(DEFAULT_LOCAL.stowIdle);
      expect(p.stowDone).toBe(DEFAULT_LOCAL.stowDone);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('档位标签', () => {
    expect(STOW_OPTS.map(stowLabel)).toEqual(['3', '5', '10', '全部']);
  });
});
