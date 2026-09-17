import { describe, expect, it } from 'vitest';
import { evAt } from './dispatch';

/**
 * 接回/刷新后,派发页整条会话的时间戳曾被抹成同一个「刚刚」(2026-09-17 实测:轮次目录 40 轮全是 17:44)。
 * 真因是回放事件与实时事件走同一条路径,而那条路径拿接收时刻打点。后端现在给回放事件带上
 * 事件当初发生的时刻(at),这里钉住前端优先用它。
 */
describe('回放事件时间戳', () => {
  it('带 at 的回放事件用 at,不用现在', () => {
    const at = Date.parse('2026-09-16T09:44:00Z');
    expect(evAt({ ev: 'user-echo', text: 'x', at })).toBe(at);
  });

  it('实时事件没有 at → 退回当前时刻', () => {
    const before = Date.now();
    const ts = evAt({ ev: 'user-echo', text: 'x' });
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('坏值(0 / 非数字)不当成 1970,退回当前时刻', () => {
    const before = Date.now();
    expect(evAt({ at: 0 })).toBeGreaterThanOrEqual(before);
    expect(evAt({ at: 'nope' })).toBeGreaterThanOrEqual(before);
  });
});
