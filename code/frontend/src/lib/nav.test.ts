import { describe, expect, it } from 'vitest';

import { VIEW_IDS } from './hooks';
import { digitOf, NAVS, stepView } from './nav';

describe('侧栏顺序与数字键顺序', () => {
  it('侧栏覆盖全部视图且不重复(新增视图漏挂侧栏会在这里红)', () => {
    const ids = NAVS.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...VIEW_IDS].sort());
  });

  it('⌥⌘→ 按侧栏顺序:经验的下一个是提示词,再下一个是定时', () => {
    expect(stepView('memory', 1)).toBe('prompts');
    expect(stepView('prompts', 1)).toBe('cron');
    expect(stepView('cron', -1)).toBe('prompts');
  });

  it('⌥⌘←/→ 首尾相接,且连按一圈恰好逐个经过侧栏每一项', () => {
    expect(stepView(NAVS[NAVS.length - 1]!.id, 1)).toBe(NAVS[0]!.id);
    expect(stepView(NAVS[0]!.id, -1)).toBe(NAVS[NAVS.length - 1]!.id);
    const seen = [NAVS[0]!.id];
    for (let i = 1; i < NAVS.length; i++) seen.push(stepView(seen[i - 1]!, 1));
    expect(seen).toEqual(NAVS.map((n) => n.id));
  });

  it('数字键不随侧栏位置变化:⌘7 仍是定时,提示词与待办没有数字键', () => {
    expect(digitOf('memory')).toBe(6);
    expect(digitOf('cron')).toBe(7);
    expect(digitOf('worklog')).toBe(9);
    expect(digitOf('prompts')).toBeNull();
    expect(digitOf('todo')).toBeNull();
  });
});
