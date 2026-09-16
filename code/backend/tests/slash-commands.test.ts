import { describe, expect, it } from 'vitest';
import { buildSlashCatalog, cachedSlashCatalog, rememberSlashCatalog } from '../src/services/slash-commands.js';

/**
 * 斜杠命令目录(派发输入框联想面板的数据源)。
 *
 * 实测背景(2026-09-16, CLI 2.1.273):
 * - SDK 的 init 报文带 `slash_commands`(117 条,只有名字)与 `terminal_slash_commands`
 *   (仅 color/doctor/reload-plugins 三条)。面板要的描述与参数提示只有
 *   `query.supportedCommands()` 才给,故目录走那条路。
 * - `claude -p '/caveman lite'` 会被 CLI 展开成技能调用(会话 jsonl 里留下 command-name 信封),
 *   `/watch` 这类插件技能的裸名同样认;未知命令 CLI 本地回 "Unknown command" 不烧模型轮次。
 *   所以面板补出来的命令原样发送即可,后端不需要翻译。
 */
describe('buildSlashCatalog', () => {
  const raw = [
    { name: 'wrapup', description: '任务收口卡:把刚完成的一个任务\n沉淀成一张卡片', argumentHint: '' },
    { name: 'watch:watch', description: 'Watch a video', argumentHint: '<video-url-or-path> [question]' },
    { name: 'caveman', description: 'Ultra-compressed', argumentHint: '' },
    { name: 'heapdump', description: 'Dump the JS heap', argumentHint: '' },
    { name: '__remote-workflow', description: 'internal', argumentHint: '' },
  ];

  it('剔除内部与终端专属命令,其余按名称排序交出', () => {
    const out = buildSlashCatalog(raw, ['color']);
    expect(out.map((c) => c.name)).toEqual(['caveman', 'watch:watch', 'wrapup']);
  });

  it('本会话报告的 terminal_slash_commands 同样被剔除', () => {
    expect(buildSlashCatalog(raw, ['caveman']).map((c) => c.name)).toEqual(['watch:watch', 'wrapup']);
  });

  it('描述压成单行:技能描述常带换行,面板一行放不下两行字', () => {
    const wrapup = buildSlashCatalog(raw).find((c) => c.name === 'wrapup');
    expect(wrapup?.desc).toBe('任务收口卡:把刚完成的一个任务 沉淀成一张卡片');
  });

  it('保留参数提示,面板选中后要靠它提示怎么填', () => {
    expect(buildSlashCatalog(raw).find((c) => c.name === 'watch:watch')?.arg).toBe('<video-url-or-path> [question]');
  });

  it('字段缺失或非字符串不抛异常,只是留空', () => {
    const out = buildSlashCatalog([{ name: 'x' }, { name: 42 }, { description: 'no name' }] as never[]);
    expect(out).toEqual([{ name: 'x', desc: '', arg: '' }]);
  });
});

describe('跨会话兜底目录', () => {
  it('记住最近一份非空目录,供新会话建立前的面板使用', () => {
    rememberSlashCatalog([{ name: 'a', desc: '', arg: '' }]);
    expect(cachedSlashCatalog().cmds.map((c) => c.name)).toEqual(['a']);
  });

  it('空目录不覆盖已有的:会话建立失败时不该把兜底清空', () => {
    rememberSlashCatalog([{ name: 'b', desc: '', arg: '' }]);
    rememberSlashCatalog([]);
    expect(cachedSlashCatalog().cmds.map((c) => c.name)).toEqual(['b']);
  });

  it('兜底目录恒标 fresh:false —— 权威列表只来自本会话的 ws commands 事件', () => {
    expect(cachedSlashCatalog().fresh).toBe(false);
  });
});
