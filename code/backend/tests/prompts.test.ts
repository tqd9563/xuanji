import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizePrompt, PIN_MAX, pinOverLimit, trigTaken } from '../src/services/prompts.js';
import { Storage } from '../src/storage/db.js';
import type { Prompt } from '../src/types.js';

const base = { trig: 'debug', name: '排障开场', body: '现象:{{cursor}}\n复现路径:', cwd: null, pinned: false };

describe('提示词校验', () => {
  it('合法输入整理后原样返回,触发词小写化', () => {
    const r = normalizePrompt({ ...base, trig: ' Debug ' });
    expect(r).toEqual({ ok: { ...base, trig: 'debug' } });
  });

  it('触发词格式:字母开头,只允许字母数字短横线', () => {
    for (const bad of ['', '1a', 'a b', 'A_B', '中文', 'x'.repeat(33)]) {
      expect('error' in normalizePrompt({ ...base, trig: bad })).toBe(true);
    }
    expect('ok' in normalizePrompt({ ...base, trig: 'a-1' })).toBe(true);
  });

  it('名称 / 正文为空拒绝;拼错的变量名报出来而不是静默存下去', () => {
    expect(normalizePrompt({ ...base, name: '  ' })).toHaveProperty('error');
    expect(normalizePrompt({ ...base, body: '\n' })).toHaveProperty('error');
    const r = normalizePrompt({ ...base, body: '目录 {{pwd}}' });
    expect('error' in r && r.error).toContain('{{pwd}}');
  });

  it('作用域只接受绝对路径或 null,尾部斜杠归一', () => {
    expect(normalizePrompt({ ...base, cwd: 'xuanji' })).toHaveProperty('error');
    const r = normalizePrompt({ ...base, cwd: '/Users/me/xuanji/' });
    expect('ok' in r && r.ok.cwd).toBe('/Users/me/xuanji');
  });

  it('部分更新:缺省字段沿用旧记录', () => {
    const old: Prompt = { id: 1, ...base, uses: 3, lastUsedAt: null, createdAt: 1, updatedAt: 1 };
    const r = normalizePrompt({ pinned: true }, old);
    expect(r).toEqual({ ok: { ...base, pinned: true } });
  });

  it('钉选上限只拦「再加一条」,改自己或取消钉选放行', () => {
    const mk = (id: number, pinned: boolean): Prompt => ({ id, ...base, trig: `t${id}`, pinned, uses: 0, lastUsedAt: null, createdAt: 1, updatedAt: 1 });
    const all = Array.from({ length: PIN_MAX }, (_, i) => mk(i + 1, true));
    expect(pinOverLimit(all, { ...base, pinned: true })).toBe(true);
    expect(pinOverLimit(all, { ...base, pinned: true }, 1)).toBe(false);
    expect(pinOverLimit(all, { ...base, pinned: false })).toBe(false);
    expect(trigTaken(all, 't2')?.id).toBe(2);
    expect(trigTaken(all, 't2', 2)).toBeNull();
  });
});

describe('Storage 提示词', () => {
  let dir: string;
  let s: Storage;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-prompts-'));
    s = new Storage(dir);
  });
  afterEach(() => {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('增删改查 + 使用计数', () => {
    const p = s.createPrompt(base);
    expect(p.id).toBeGreaterThan(0);
    expect(p.uses).toBe(0);
    expect(s.getPromptByTrig('debug')?.id).toBe(p.id);
    s.updatePrompt(p.id, { name: '改名', pinned: true });
    expect(s.getPrompt(p.id)).toMatchObject({ name: '改名', pinned: true });
    s.bumpPromptUse(p.id);
    s.bumpPromptUse(p.id);
    expect(s.getPrompt(p.id)!.uses).toBe(2);
    expect(s.getPrompt(p.id)!.lastUsedAt).not.toBeNull();
    s.deletePrompt(p.id);
    expect(s.getPrompt(p.id)).toBeNull();
  });

  it('触发词唯一:重复插入抛错', () => {
    s.createPrompt(base);
    expect(() => s.createPrompt({ ...base, name: '另一条' })).toThrow();
  });

  it('列表顺序:钉选在前,再按使用次数', () => {
    const a = s.createPrompt({ ...base, trig: 'a' });
    const b = s.createPrompt({ ...base, trig: 'b' });
    const c = s.createPrompt({ ...base, trig: 'c', pinned: true });
    s.bumpPromptUse(b.id);
    expect(s.listPrompts().map((p) => p.id)).toEqual([c.id, b.id, a.id]);
  });
});
