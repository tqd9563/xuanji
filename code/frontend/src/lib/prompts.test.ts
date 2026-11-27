import { describe, expect, it } from 'vitest';

import type { Prompt } from '@/api/types';
import type { SlashCmd } from './slash';
import {
  buildSlashRows,
  filterPromptsView,
  pinnedChips,
  promptQuery,
  resolvePromptBody,
  selectableRows,
  visiblePrompts,
} from './prompts';

const mk = (o: Partial<Prompt> & { trig: string }): Prompt => ({
  id: o.trig.length,
  name: o.trig,
  body: '',
  cwd: null,
  pinned: false,
  uses: 0,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...o,
});
const cmd = (name: string, uses = 0): SlashCmd => ({ name, desc: '', arg: '', kind: 'builtin', uses });

describe('promptQuery', () => {
  it('只在「/p 空格」之后进入提示词模式', () => {
    expect(promptQuery('/p')).toBeNull(); // 还在普通联想里(命中 /p 这条命令)
    expect(promptQuery('/p ')).toBe('');
    expect(promptQuery('/p De')).toBe('de');
    expect(promptQuery('/p de ')).toBeNull(); // 第二个空格 = 参数写完,面板收起
    expect(promptQuery('/wd x')).toBeNull();
    expect(promptQuery('hello')).toBeNull();
  });
});

describe('visiblePrompts / pinnedChips', () => {
  const all = [
    mk({ trig: 'g', pinned: true, uses: 1 }),
    mk({ trig: 'x', cwd: '/a', pinned: true, uses: 9 }),
    mk({ trig: 'y', cwd: '/b', pinned: true }),
    mk({ trig: 'n', pinned: false, uses: 99 }),
  ];
  it('只看全局 + 当前目录的;chip 按次数取前 max', () => {
    expect(visiblePrompts(all, '/a').map((p) => p.trig)).toEqual(['g', 'x', 'n']);
    expect(pinnedChips(all, '/a', 4).map((p) => p.trig)).toEqual(['x', 'g']);
    expect(pinnedChips(all, '/a', 1).map((p) => p.trig)).toEqual(['x']);
    expect(pinnedChips(all, null, 4).map((p) => p.trig)).toEqual(['g']);
  });
});

describe('buildSlashRows', () => {
  const cmds = [cmd('model', 250), cmd('p', 12), cmd('clear', 6), cmd('memory')];
  const prompts = [mk({ trig: 'close', uses: 23 }), mk({ trig: 'debug', uses: 11 }), mk({ trig: 'bg', uses: 9 }), mk({ trig: 'en', uses: 0 })];

  it('空 `/`:提示词组(前 3 条)+ 命令组,各带标题行', () => {
    const rows = buildSlashRows({ slashQ: '', promptQ: null, cmds, prompts });
    expect(rows.map((r) => (r.kind === 'grp' ? `#${r.label}` : r.kind === 'prompt' ? r.prompt.trig : r.cmd.name))).toEqual([
      '#提示词', 'close', 'debug', 'bg', '#命令', 'model', 'p', 'clear', 'memory',
    ]);
    expect(selectableRows(rows)).toHaveLength(7);
  });

  it('空 `/` 且没有提示词:退化成今天的扁平命令表,不出分组标题', () => {
    const rows = buildSlashRows({ slashQ: '', promptQ: null, cmds, prompts: [] });
    expect(rows.every((r) => r.kind === 'cmd')).toBe(true);
  });

  it('`/p xxx`:只看提示词,触发词前缀优先于子串', () => {
    const rows = buildSlashRows({ slashQ: 'p', promptQ: 'e', cmds, prompts: [...prompts, mk({ trig: 'en2', name: '翻译' })] });
    expect(rows.map((r) => r.kind === 'prompt' && r.prompt.trig)).toEqual(['en', 'en2', 'close', 'debug']);
  });

  it('`/xx`:命令与提示词混排,前缀命中在前,同层按次数', () => {
    const rows = buildSlashRows({ slashQ: 'c', promptQ: null, cmds, prompts });
    // 前缀命中:clear(6) 与 close(23) 同层 → close 次数多排前;memory 不含 c 不出现
    expect(rows.map((r) => (r.kind === 'prompt' ? r.prompt.trig : r.kind === 'cmd' ? r.cmd.name : '#'))).toEqual(['close', 'clear']);
    expect(rows.some((r) => r.kind === 'grp')).toBe(false);
  });
});

describe('resolvePromptBody', () => {
  it('替换变量,{{cursor}} 第一处定光标且全部移除', () => {
    const r = resolvePromptBody('目录 {{cwd}} 分支 {{branch}}\n现象:{{cursor}}\n{{cursor}}尾 {{date}}', {
      cwd: '/x',
      branch: 'dev',
      date: '2026-10-14',
    });
    expect(r.text).toBe('目录 /x 分支 dev\n现象:\n尾 2026-10-14');
    expect(r.caret).toBe('目录 /x 分支 dev\n现象:'.length);
  });
  it('没有 {{cursor}} 时光标落在末尾;缺值变量替换为空而不是留下字面量', () => {
    const r = resolvePromptBody('a {{clipboard}} b', {});
    expect(r.text).toBe('a  b');
    expect(r.caret).toBe(r.text.length);
  });
});

describe('filterPromptsView', () => {
  const all = [mk({ trig: 'g', name: '全局的', body: 'hello' }), mk({ trig: 'x', cwd: '/a', pinned: true, body: 'world' })];
  it('标签与搜索叠加', () => {
    expect(filterPromptsView(all, 'pinned', '').map((p) => p.trig)).toEqual(['x']);
    expect(filterPromptsView(all, 'global', '').map((p) => p.trig)).toEqual(['g']);
    expect(filterPromptsView(all, 'project', '').map((p) => p.trig)).toEqual(['x']);
    expect(filterPromptsView(all, 'all', 'WORLD').map((p) => p.trig)).toEqual(['x']);
    expect(filterPromptsView(all, 'all', '全局').map((p) => p.trig)).toEqual(['g']);
  });
});
