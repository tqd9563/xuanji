import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendJank, readJank, sanitizeJank } from '../src/services/client-jank.js';

describe('前端卡顿记录', () => {
  it('缺 stallMs 或非对象一律拒收', () => {
    expect(sanitizeJank(null)).toBeNull();
    expect(sanitizeJank('x')).toBeNull();
    expect(sanitizeJank({ view: 'sessions' })).toBeNull();
  });

  it('只收白名单字段并截断长度', () => {
    const rec = sanitizeJank({ stallMs: 812.4, view: 'sessions', evil: 'drop me', ua: 'x'.repeat(500), scripts: ['a', 'b'] })!;
    expect(rec.stallMs).toBe(812);
    expect(rec).not.toHaveProperty('evil');
    expect((rec.ua as string).length).toBe(200);
    expect(rec.scripts).toEqual(['a', 'b']);
  });

  it('追加后能按 limit 读回最新几条,坏行跳过', async () => {
    const file = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jank-')), 'j.jsonl');
    for (let i = 0; i < 5; i++) await appendJank({ stallMs: i }, file);
    await fs.promises.appendFile(file, '{broken\n');
    const got = await readJank(2, file);
    expect(got.map((r) => r.stallMs)).toEqual([3, 4]);
  });
});
