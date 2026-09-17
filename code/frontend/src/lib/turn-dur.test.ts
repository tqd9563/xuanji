/** 轮次耗时格式化:状态条实时「已用」与消息头定格的「本轮」共用这一个函数,两处必然同形 */
import { describe, expect, it } from 'vitest';
import { fmtTurnDur, idleStatusText } from './utils';

describe('fmtTurnDur', () => {
  it('不足一分钟只给整秒(轮次尺度上毫秒是噪音)', () => {
    expect(fmtTurnDur(0)).toBe('0s');
    expect(fmtTurnDur(1_400)).toBe('1s');
    expect(fmtTurnDur(46_800)).toBe('47s');
  });
  it('分钟档 m + 两位秒,秒位补零保证逐位对齐', () => {
    expect(fmtTurnDur(60_000)).toBe('1m00s');
    expect(fmtTurnDur(67_000)).toBe('1m07s');
    expect(fmtTurnDur(192_000)).toBe('3m12s');
  });
  it('小时档进位到 h + 两位分,不再显示秒', () => {
    expect(fmtTurnDur(3_600_000)).toBe('1h00m');
    expect(fmtTurnDur(3_840_000)).toBe('1h04m');
  });
  it('档位边界按四舍五入后的秒数判定(59.6s 已进位成 1m00s,不留 60s 这种写法)', () => {
    expect(fmtTurnDur(59_600)).toBe('1m00s');
    expect(fmtTurnDur(3_599_600)).toBe('1h00m');
  });
  it('负数与异常值收敛到 0s,不渲染出 -1s', () => {
    expect(fmtTurnDur(-500)).toBe('0s');
  });
});

describe('idleStatusText', () => {
  it('耗时与成本都在时按「本轮 → 本会话」排列', () => {
    expect(idleStatusText(129_000, 1.07)).toBe('空闲 · 回合结束 · 本轮 2m09s · 本会话 $1.07');
  });
  it('接回存活会话拿不到本轮起点时不占位(退回改动前的原样)', () => {
    expect(idleStatusText(null, 1.07)).toBe('空闲 · 回合结束 · 本会话 $1.07');
    expect(idleStatusText(null, 0)).toBe('空闲 · 回合结束');
  });
  it('成本为 0 时只留耗时', () => {
    expect(idleStatusText(19_000, 0)).toBe('空闲 · 回合结束 · 本轮 19s');
  });
});
