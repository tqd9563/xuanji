import { describe, expect, it } from 'vitest';
import {
  comboOf,
  findConflict,
  formatCombo,
  KEYMAP_DEFAULTS,
  KEY_ACTIONS,
  matchKey,
  normalizeKeymap,
  type KeyLike,
} from './keymap';

/** 平台按参数注入,不依赖 navigator —— 前端测试跑在 node 环境 */
const MAC = true;
const WIN = false;

const ev = (init: Partial<KeyLike>): KeyLike => ({
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe('keymap 表本身', () => {
  it('每个 action 都有默认键位,没有孤儿', () => {
    for (const a of KEY_ACTIONS) expect(KEYMAP_DEFAULTS[a.id], a.id).toBeTruthy();
    expect(Object.keys(KEYMAP_DEFAULTS).length).toBe(KEY_ACTIONS.length);
  });

  it('默认键位两两不撞', () => {
    const seen = new Map<string, string>();
    for (const [id, combo] of Object.entries(KEYMAP_DEFAULTS)) {
      expect(seen.get(combo), `${combo} 被 ${seen.get(combo)} 与 ${id} 同时占用`).toBeUndefined();
      seen.set(combo, id);
    }
  });
});

describe('comboOf', () => {
  it('Mac 上 ⌘ 记作 mod,⌃ 记作 ctrl', () => {
    expect(comboOf(ev({ key: 'n', metaKey: true }), MAC)).toBe('mod+n');
    expect(comboOf(ev({ key: 'x', ctrlKey: true }), MAC)).toBe('ctrl+x');
  });

  it('非 Mac 上 Ctrl 记作 mod', () => {
    expect(comboOf(ev({ key: 'n', ctrlKey: true }), WIN)).toBe('mod+n');
  });

  it('修饰键顺序固定,不因按下顺序而变', () => {
    expect(comboOf(ev({ key: 'O', metaKey: true, shiftKey: true }), MAC)).toBe('mod+shift+o');
  });

  it('方向键与逗号有稳定写法', () => {
    expect(comboOf(ev({ key: 'ArrowUp', altKey: true }), MAC)).toBe('alt+arrowup');
    expect(comboOf(ev({ key: ',', metaKey: true }), MAC)).toBe('mod+,');
  });

  it('只按修饰键不构成组合', () => {
    expect(comboOf(ev({ key: 'Meta', metaKey: true }), MAC)).toBe('');
    expect(comboOf(ev({ key: 'Shift', shiftKey: true }), MAC)).toBe('');
  });

  it('⌥ 在 Mac 上把字母变成变音符号,用 code 还原', () => {
    // 实机按 ⌥E 时 e.key 是 "´" 而不是 "e"
    expect(comboOf(ev({ key: '´', altKey: true, code: 'KeyE' }), MAC)).toBe('alt+e');
  });
});

describe('matchKey', () => {
  it('命中与不命中', () => {
    expect(matchKey(ev({ key: 'm', metaKey: true }), 'mod+m', MAC)).toBe(true);
    expect(matchKey(ev({ key: 'm' }), 'mod+m', MAC)).toBe(false);
    // 多按一个修饰键就不是同一个组合,不能宽松匹配
    expect(matchKey(ev({ key: 'm', metaKey: true, shiftKey: true }), 'mod+m', MAC)).toBe(false);
  });

  it('空组合永不命中(某动作被清空时不该变成「按什么都触发」)', () => {
    expect(matchKey(ev({ key: 'm', metaKey: true }), '', MAC)).toBe(false);
  });
});

describe('formatCombo', () => {
  it('Mac 出符号', () => {
    expect(formatCombo('mod+shift+o', MAC)).toBe('⌘⇧O');
    expect(formatCombo('alt+arrowup', MAC)).toBe('⌥↑');
    expect(formatCombo('mod+enter', MAC)).toBe('⌘⏎');
  });

  it('非 Mac 出单词并用加号连接', () => {
    expect(formatCombo('mod+shift+o', WIN)).toBe('Ctrl+Shift+O');
  });
});

describe('findConflict', () => {
  it('找出占用同一组合的另一个动作', () => {
    const map = { ...KEYMAP_DEFAULTS, 'dispatch.model': 'mod+n' } as typeof KEYMAP_DEFAULTS;
    expect(findConflict(map, 'mod+n', 'dispatch.model')).toBe('global.newSession');
  });

  it('自己占着自己不算冲突', () => {
    expect(findConflict(KEYMAP_DEFAULTS, 'mod+n', 'global.newSession')).toBeNull();
  });

  it('默认表里任取一个键位都只被自己占用', () => {
    for (const [id, combo] of Object.entries(KEYMAP_DEFAULTS)) {
      expect(findConflict(KEYMAP_DEFAULTS, combo, id as never), id).toBeNull();
    }
  });
});

describe('normalizeKeymap', () => {
  it('保留合法覆写', () => {
    expect(normalizeKeymap({ 'dispatch.model': 'mod+k' })['dispatch.model']).toBe('mod+k');
  });

  it('丢弃已删除的 action 与坏值,缺的补默认', () => {
    const m = normalizeKeymap({ 'gone.action': 'mod+z', 'dispatch.model': 42, 'sessions.find': '' });
    expect(m).not.toHaveProperty('gone.action');
    expect(m['dispatch.model']).toBe(KEYMAP_DEFAULTS['dispatch.model']);
    expect(m['sessions.find']).toBe(KEYMAP_DEFAULTS['sessions.find']);
  });

  it('入参为 null 时给出完整默认表', () => {
    expect(normalizeKeymap(null)).toEqual(KEYMAP_DEFAULTS);
  });
});
