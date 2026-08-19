import { describe, expect, it } from 'vitest';
import { dayLabel, daySeparator, msgClock } from '../src/lib/utils';

/** 构造本地时区的时刻,避免用例随运行机器时区飘 */
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe('msgClock', () => {
  it('ms epoch 与 ISO 串都归一为 HH:MM', () => {
    expect(msgClock(at(2026, 8, 19, 9, 5))).toBe('09:05');
    expect(msgClock(new Date(at(2026, 8, 19, 23, 47)).toISOString())).toBe('23:47');
  });

  it('无时间(工具事件)与不可解析的串返回 null,不渲染占位', () => {
    expect(msgClock(undefined)).toBeNull();
    expect(msgClock(null)).toBeNull();
    expect(msgClock('not-a-date')).toBeNull();
  });
});

describe('daySeparator', () => {
  it('首条带时间的消息之前总插一条日期', () => {
    expect(daySeparator(undefined, at(2026, 8, 19, 9, 0))).toBe(dayLabel(at(2026, 8, 19, 9, 0)));
  });

  it('同一天内不插', () => {
    expect(daySeparator(at(2026, 8, 19, 0, 1), at(2026, 8, 19, 23, 59))).toBeNull();
  });

  it('跨自然日插:相隔仅几分钟但跨过午夜也算跨天', () => {
    expect(daySeparator(at(2026, 8, 18, 23, 58), at(2026, 8, 19, 0, 3))).toBe(
      dayLabel(at(2026, 8, 19, 0, 3)),
    );
  });

  it('相隔近 24 小时但仍在同一天则不插', () => {
    expect(daySeparator(at(2026, 8, 19, 0, 5), at(2026, 8, 19, 23, 55))).toBeNull();
  });

  it('跨月与跨年同样按日历日判定', () => {
    expect(daySeparator(at(2026, 8, 31, 22, 0), at(2026, 9, 1, 1, 0))).toBe(dayLabel(at(2026, 9, 1, 1, 0)));
    expect(daySeparator(at(2025, 12, 31, 22, 0), at(2026, 1, 1, 1, 0))).toBe(dayLabel(at(2026, 1, 1, 1, 0)));
  });

  it('本条无时间则不插(工具卡不参与跨天)', () => {
    expect(daySeparator(at(2026, 8, 18, 9, 0), undefined)).toBeNull();
  });
});

describe('dayLabel', () => {
  it('日期 + 周几', () => {
    expect(dayLabel(at(2026, 8, 19, 12, 0))).toBe('2026-08-19 · 周三');
  });
});
