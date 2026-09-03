import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, DEFAULT_LOCAL } from './prefs';
import { KEYMAP_DEFAULTS } from './keymap';

describe('偏好默认值', () => {
  it('本机默认值与快捷键表同源,不各写一份', () => {
    expect(DEFAULT_LOCAL.keymap).toBe(KEYMAP_DEFAULTS);
  });

  it('发送键默认沿用 ⌘⏎ 发送(PR#45 之后的现状),不擅自改语义', () => {
    expect(DEFAULT_LOCAL.sendKey).toBe('mod');
  });

  it('账户默认值与后端 DEFAULT_PREFS 保持一致的关键项', () => {
    // 后端 services/prefs.ts 同名常量;两处不一致会让首次加载前后界面跳一下
    expect(DEFAULT_ACCOUNT.perm).toBe('bypassPermissions');
    expect(DEFAULT_ACCOUNT.model).toBe('');
    expect(DEFAULT_ACCOUNT.cwd).toBe('');
    expect(DEFAULT_ACCOUNT.bg).toBe(false);
  });

  it('终端会话通知默认关,其余默认开', () => {
    expect(DEFAULT_ACCOUNT.notify.terminal).toBe(false);
    expect(DEFAULT_ACCOUNT.notify.dispatched).toBe(true);
    expect(DEFAULT_ACCOUNT.notify.blocked).toBe(true);
  });
});
