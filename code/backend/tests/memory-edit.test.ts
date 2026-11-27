import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import { invalidateMemoryCache, listMemories } from '../src/services/memories.js';
import { MemoryEditError, deleteMemory, listTrash, memoryDetail, restoreMemory, updateMemory } from '../src/services/memory-edit.js';

/** 临时 ~/.claude:两个项目 + 一个共享库;demo 里一条普通经验、一条共享软链,other 也挂着同一条共享 */
let root: string;
const saved = { claudeDir: config.claudeDir, trashDir: config.trashDir };
const memDir = (slug: string) => path.join(root, 'claude', 'projects', slug, 'memory');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const md = (name: string, desc: string, body: string) => `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: feedback\n  origin: session-1\n---\n\n${body}\n`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-memedit-'));
  // config 是 as const 的只读类型;测试里按既有约定整体覆盖后在 afterEach 还原
  Object.assign(config, { claudeDir: path.join(root, 'claude'), trashDir: path.join(root, 'trash') });
  fs.mkdirSync(path.join(root, 'claude', 'memory-shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'claude', 'memory-shared', 'shared-one.md'), md('shared-one', '共享描述', '共享正文'));
  for (const slug of ['-tmp-demo', '-tmp-other']) {
    fs.mkdirSync(memDir(slug), { recursive: true });
    fs.symlinkSync('../../../memory-shared/shared-one.md', path.join(memDir(slug), 'shared-one.md'));
  }
  fs.writeFileSync(path.join(memDir('-tmp-demo'), 'alpha.md'), md('alpha', '旧描述', '旧正文,见 [[beta]]'));
  fs.writeFileSync(path.join(memDir('-tmp-demo'), 'beta.md'), md('beta', 'b', 'b 正文'));
  fs.writeFileSync(
    path.join(memDir('-tmp-demo'), 'MEMORY.md'),
    '# Memory Index\n\n- [Alpha 标题](alpha.md) — 手写的 alpha 摘要\n- [Beta](beta.md) — 手写的 beta 摘要\n- [共享](shared-one.md) — 共享记忆:demo 侧摘要\n',
  );
  fs.writeFileSync(path.join(memDir('-tmp-other'), 'MEMORY.md'), '# Memory Index\n\n- [共享](shared-one.md) — 共享记忆:other 侧摘要\n');
  invalidateMemoryCache();
});
afterEach(() => {
  Object.assign(config, saved);
  invalidateMemoryCache();
  fs.rmSync(root, { recursive: true, force: true });
});

const alpha = () => path.join(memDir('-tmp-demo'), 'alpha.md');
const sharedDemo = () => path.join(memDir('-tmp-demo'), 'shared-one.md');
const sharedOther = () => path.join(memDir('-tmp-other'), 'shared-one.md');
const sharedReal = () => path.join(root, 'claude', 'memory-shared', 'shared-one.md');

describe('经验列表的新字段', () => {
  it('索引摘要取自 MEMORY.md 而不是 description;共享经验列出其它挂载项目', async () => {
    const all = await listMemories();
    const a = all.find((m) => m.file === alpha())!;
    expect(a).toMatchObject({ indexHook: '手写的 alpha 摘要', description: '旧描述', sharedWith: null, truncated: false });
    const s = all.find((m) => m.file === sharedDemo())!;
    expect(s.sharedWith).toEqual(['other']);
    expect(s.indexHook).toBe('共享记忆:demo 侧摘要');
  });
});

describe('编辑经验', () => {
  it('改描述 / 类型 / 正文:写回文件,保留 frontmatter 里不认识的键,索引行不动', async () => {
    const before = await memoryDetail(alpha());
    const after = await updateMemory({ file: alpha(), description: ' 新描述\n第二行 ', type: 'project', body: '新正文', rev: before.rev });
    expect(after).toMatchObject({ description: '新描述 第二行', type: 'project', body: '新正文' });
    const raw = read(alpha());
    expect(raw).toContain('origin: session-1');
    expect(raw).toContain('type: project');
    expect(read(path.join(memDir('-tmp-demo'), 'MEMORY.md'))).toContain('- [Alpha 标题](alpha.md) — 手写的 alpha 摘要');
  });

  it('索引摘要是独立字段:改了才写,只改那一行,标题原样保留', async () => {
    const d = await memoryDetail(alpha());
    await updateMemory({ file: alpha(), description: d.description, type: 'feedback', body: d.body, indexHook: '新的摘要', rev: d.rev });
    const idx = read(path.join(memDir('-tmp-demo'), 'MEMORY.md'));
    expect(idx).toContain('- [Alpha 标题](alpha.md) — 新的摘要');
    expect(idx).toContain('- [Beta](beta.md) — 手写的 beta 摘要');
    expect((await memoryDetail(alpha())).indexHook).toBe('新的摘要');
  });

  it('文件在打开之后被别处改过:拒绝并带回最新内容;force 才覆盖', async () => {
    const d = await memoryDetail(alpha());
    fs.writeFileSync(alpha(), md('alpha', '别处改的', '别处的正文'));
    const err = await updateMemory({ file: alpha(), description: 'x', type: 'feedback', body: '我的', rev: d.rev }).catch((e) => e);
    expect(err).toBeInstanceOf(MemoryEditError);
    expect(err.status).toBe(409);
    expect((err.extra.latest as { body: string }).body).toBe('别处的正文');
    expect(read(alpha())).toContain('别处的正文');
    await updateMemory({ file: alpha(), description: 'x', type: 'feedback', body: '我的', rev: d.rev, force: true });
    expect(read(alpha())).toContain('我的');
  });

  it('共享经验写到真身,软链本身不被换成普通文件', async () => {
    const d = await memoryDetail(sharedDemo());
    await updateMemory({ file: sharedDemo(), description: d.description, type: 'feedback', body: '改过的共享正文', rev: d.rev });
    expect(fs.lstatSync(sharedDemo()).isSymbolicLink()).toBe(true);
    expect(read(sharedReal())).toContain('改过的共享正文');
    expect(read(sharedOther())).toContain('改过的共享正文');
  });

  it('路径不在 projects/<slug>/memory/ 下、或指向 MEMORY.md,一律拒绝', async () => {
    for (const bad of [path.join(root, 'claude', 'settings.json'), path.join(memDir('-tmp-demo'), 'MEMORY.md'), path.join(memDir('-tmp-demo'), '..', '..', '..', 'x.md'), sharedReal(), '']) {
      const err = await memoryDetail(bad).catch((e) => e);
      expect(err).toBeInstanceOf(MemoryEditError);
      expect(err.status).toBe(400);
    }
  });

  it('空正文、不合法类型拒绝', async () => {
    const d = await memoryDetail(alpha());
    await expect(updateMemory({ file: alpha(), description: 'x', type: 'feedback', body: '  ', rev: d.rev })).rejects.toThrow('正文不能为空');
    await expect(updateMemory({ file: alpha(), description: 'x', type: 'bogus', body: 'b', rev: d.rev })).rejects.toThrow('类型不合法');
    // unknown = 没改类型:原样保留
    await updateMemory({ file: alpha(), description: 'x', type: 'unknown', body: 'b', rev: d.rev });
    expect(read(alpha())).toContain('type: feedback');
  });
});

describe('删除与恢复', () => {
  it('普通经验:文件进回收目录、索引行移除;恢复后文件与索引行原样回到原位', async () => {
    const idxBefore = read(path.join(memDir('-tmp-demo'), 'MEMORY.md'));
    const rawBefore = read(alpha());
    const t = await deleteMemory({ file: alpha() });
    expect(t.mode).toBe('file');
    expect(fs.existsSync(alpha())).toBe(false);
    expect(read(path.join(memDir('-tmp-demo'), 'MEMORY.md'))).not.toContain('alpha.md');
    expect((await listMemories()).some((m) => m.file === alpha())).toBe(false);
    const trash = await listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]!.memory).toMatchObject({ name: 'alpha', file: alpha(), indexHook: '手写的 alpha 摘要' });

    await restoreMemory(t.id);
    expect(read(alpha())).toBe(rawBefore);
    expect(read(path.join(memDir('-tmp-demo'), 'MEMORY.md'))).toBe(idxBefore);
    expect(await listTrash()).toHaveLength(0);
  });

  it('共享经验默认只卸载本项目:真身与其它项目不受影响;恢复重建同一条软链', async () => {
    const t = await deleteMemory({ file: sharedDemo() });
    expect(t.mode).toBe('unmount');
    expect(fs.existsSync(sharedDemo())).toBe(false);
    expect(fs.existsSync(sharedReal())).toBe(true);
    expect(read(sharedOther())).toContain('共享正文');
    expect(read(path.join(memDir('-tmp-other'), 'MEMORY.md'))).toContain('shared-one.md');
    await restoreMemory(t.id);
    expect(fs.readlinkSync(sharedDemo())).toBe('../../../memory-shared/shared-one.md');
    expect(read(path.join(memDir('-tmp-demo'), 'MEMORY.md'))).toContain('- [共享](shared-one.md) — 共享记忆:demo 侧摘要');
  });

  it('连真身一起删:所有挂载的软链与索引行都移除;恢复后全部回来', async () => {
    const t = await deleteMemory({ file: sharedDemo(), mode: 'all' });
    expect(t.mode).toBe('all');
    for (const p of [sharedDemo(), sharedOther(), sharedReal()]) expect(fs.existsSync(p)).toBe(false);
    expect(read(path.join(memDir('-tmp-other'), 'MEMORY.md'))).not.toContain('shared-one.md');
    await restoreMemory(t.id);
    expect(read(sharedReal())).toContain('共享正文');
    expect(fs.lstatSync(sharedOther()).isSymbolicLink()).toBe(true);
    expect(read(path.join(memDir('-tmp-other'), 'MEMORY.md'))).toContain('共享记忆:other 侧摘要');
  });

  it('原位置已有同名文件时拒绝恢复,回收记录保留', async () => {
    const t = await deleteMemory({ file: alpha() });
    fs.writeFileSync(alpha(), '后来新建的同名文件');
    const err = await restoreMemory(t.id).catch((e) => e);
    expect(err.status).toBe(409);
    expect(read(alpha())).toBe('后来新建的同名文件');
    expect(await listTrash()).toHaveLength(1);
  });
});
