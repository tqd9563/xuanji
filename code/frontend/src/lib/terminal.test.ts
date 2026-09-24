import { describe, expect, it } from 'vitest';
import type { GhosttyInfo } from '@/api/types';
import { KEYMAP_DEFAULTS } from '@/lib/keymap';
import {
  BUILTIN_THEMES,
  contextCwd,
  editLook,
  fontNoteOf,
  keyConflicts,
  LOOK_DEFAULTS,
  matchToggleKey,
  normalizeLook,
  resolveLook,
  shortPath,
  toXtermTheme,
  XUANJI_THEME,
} from '@/lib/terminal';

const frappe = BUILTIN_THEMES.find((t) => t.name === 'Catppuccin Frappe')!;
/** 2026-09-24 本机实测的 Ghostty 配置 */
const G: GhosttyInfo = {
  version: '1.3.1',
  configPath: '/Users/u/Library/Application Support/com.mitchellh.ghostty/config.ghostty',
  theme: frappe,
  fontConfigured: 'Maple Mono NF CN',
  fontActual: 'JetBrains Mono',
  fontSize: 14,
  opacity: 90,
  blur: 30,
  cursorStyle: 'bar',
  cursorBlink: true,
  globalKeys: [],
  command: '/usr/bin/arch -arm64 /bin/zsh --login',
};
const ev = (p: Partial<KeyboardEvent>) =>
  ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p }) as KeyboardEvent;

describe('内置主题', () => {
  it('每款都是完整 16 色 + 合法 hex', () => {
    for (const t of BUILTIN_THEMES) {
      expect(t.palette, t.name).toHaveLength(16);
      for (const c of [...t.palette, t.background, t.foreground, t.cursor, t.selection]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('toXtermTheme:画布透明,16 色按 ANSI 序映射', () => {
    const x = toXtermTheme(frappe);
    expect(x.background).toBe('#00000000');
    expect(x.cursorAccent).toBe('#303446');
    expect(x.red).toBe('#e78284');
    expect(x.brightWhite).toBe('#b5bfe2');
  });
});

describe('外观解析', () => {
  it('跟随 Ghostty:主题/字号/透明度/模糊/光标全取 Ghostty,字体取实际渲染的', () => {
    const r = resolveLook(LOOK_DEFAULTS, G);
    expect(r).toMatchObject({ fontName: 'JetBrains Mono', fontSize: 14, opacity: 90, blur: 30, cursorStyle: 'bar', background: '#303446' });
    expect(r.theme.name).toBe('Catppuccin Frappe');
    expect(r.fontNote).toContain('Maple Mono NF CN 本机未安装');
  });

  it('读不到 Ghostty:璇玑玉色 + 不透明 + 无模糊(磨砂即选项)', () => {
    const r = resolveLook(LOOK_DEFAULTS, null);
    expect(r.theme.name).toBe(XUANJI_THEME);
    expect(r.opacity).toBe(100);
    expect(r.blur).toBe(0);
  });

  it('跟随态下改一项:转自定义,其余项保留 Ghostty 的值而不是跳回默认', () => {
    const next = editLook(LOOK_DEFAULTS, G, { bg: '#1a2b1f' });
    expect(next.mode).toBe('custom');
    const r = resolveLook(next, G);
    expect(r).toMatchObject({ background: '#1a2b1f', opacity: 90, blur: 30, fontSize: 14, cursorStyle: 'bar' });
    expect(r.theme.name).toBe('Catppuccin Frappe');
  });

  it('换主题时背景色回到该主题自带的', () => {
    const custom = editLook(LOOK_DEFAULTS, G, { bg: '#123456' });
    const r = resolveLook(editLook(custom, G, { theme: 'Catppuccin Mocha', bg: null }), G);
    expect(r.background).toBe('#1e1e2e');
  });

  it('自定义态选中不在内置表里的 Ghostty 主题,仍解析到 Ghostty 那份', () => {
    const mine = { ...frappe, name: 'My Own', background: '#010203' };
    const g2 = { ...G, theme: mine };
    const look = normalizeLook({ ...LOOK_DEFAULTS, mode: 'custom', theme: 'My Own' });
    expect(look.theme).toBe('My Own');
    expect(resolveLook(look, g2).background).toBe('#010203');
  });

  it('normalizeLook 夹住越界值、丢掉坏颜色', () => {
    const l = normalizeLook({ opacity: 5, blur: 99, fontSize: 40, bg: 'red', cursorStyle: 'x', height: 10 });
    expect(l).toMatchObject({ opacity: 100, blur: 0, fontSize: 13, bg: null, cursorStyle: 'block', height: 340 });
  });

  it('fontNoteOf:配置与实际一致时不误报未安装', () => {
    expect(fontNoteOf({ ...G, fontConfigured: 'JetBrains Mono' }).note).not.toContain('未安装');
    expect(fontNoteOf(null).name).toBe('JetBrains Mono');
  });
});

describe('呼出键', () => {
  it('默认 ⌘`', () => {
    expect(KEYMAP_DEFAULTS['global.terminal']).toBe('mod+`');
  });

  it('⌘` 命中;中文输入法把 ` 变成别的字符时按物理键 Backquote 兜底', () => {
    expect(matchToggleKey(ev({ key: '`', code: 'Backquote', metaKey: true }), 'mod+`', true)).toBe(true);
    expect(matchToggleKey(ev({ key: '·', code: 'Backquote', metaKey: true }), 'mod+`', true)).toBe(true);
  });

  it('修饰键不一致不命中;非反引号组合不走兜底', () => {
    expect(matchToggleKey(ev({ key: '`', code: 'Backquote', ctrlKey: true }), 'mod+`', true)).toBe(false);
    expect(matchToggleKey(ev({ key: '·', code: 'Backquote', metaKey: true, shiftKey: true }), 'mod+`', true)).toBe(false);
    expect(matchToggleKey(ev({ key: 'j', code: 'KeyJ', metaKey: true }), 'mod+`', true)).toBe(false);
  });

  it('keyConflicts:Ghostty 全局热键与启用中的系统快捷键才算,已关闭的不算', () => {
    const sys = [{ id: 27, name: '移动焦点到下一个窗口', combo: 'mod+`', enabled: true }];
    const both = keyConflicts('mod+`', { ...G, globalKeys: ['mod+`'] }, sys);
    expect(both.map((c) => c.who)).toEqual(['Ghostty 全局热键', 'macOS「移动焦点到下一个窗口」']);
    expect(keyConflicts('mod+`', G, [{ ...sys[0]!, enabled: false }])).toEqual([]);
    expect(keyConflicts('ctrl+`', { ...G, globalKeys: ['mod+`'] }, sys)).toEqual([]);
  });
});

describe('新终端目录', () => {
  it('跟随会话:在派发页取会话目录,否则上次目录,都没有回家', () => {
    expect(contextCwd('session', '/w/proj-wt', '/w/last')).toBe('/w/proj-wt');
    expect(contextCwd('session', null, '/w/last')).toBe('/w/last');
    expect(contextCwd('session', null, null)).toBe('~');
    expect(contextCwd('last', '/w/proj-wt', '/w/last')).toBe('/w/last');
    expect(contextCwd('home', '/w/proj-wt', '/w/last')).toBe('~');
  });

  it('shortPath 把家目录缩成 ~', () => {
    expect(shortPath('/Users/lilithgames/xuanji')).toBe('~/xuanji');
    expect(shortPath('/opt/x')).toBe('/opt/x');
  });
});
