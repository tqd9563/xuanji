/**
 * 技能触发统计用例。按「数字会不会算错」组织:
 * 解析(哪些行算一次触发)、增量(重扫会不会翻倍)、窗口归属(边界日算哪边)、命名空间(裸名能否对上)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractSkillInvocations, localDay } from '../src/adapters/claude-dir.js';
import { Storage } from '../src/storage/db.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-skill-usage-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 造一条 assistant 事件行:含 n 个 Skill tool_use 块 */
const line = (ts: string, skills: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id: `msg_${ts}_${skills.join('_')}`,
      content: skills.map((s) => ({ type: 'tool_use', id: 't', name: 'Skill', input: { skill: s } })),
    },
    ...extra,
  });

const writeJsonl = (name: string, lines: string[]) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
};

describe('extractSkillInvocations — 哪些行算一次触发', () => {
  it('抽出 assistant 事件里的 Skill tool_use,一块算一次', async () => {
    const p = writeJsonl('a.jsonl', [
      line('2026-08-20T10:00:00.000Z', ['baize']),
      line('2026-08-20T11:00:00.000Z', ['baize', 'wrapup']), // 同一条消息里两个技能
    ]);
    const inv = await extractSkillInvocations(p);
    expect(inv.map((i) => i.skill)).toEqual(['baize', 'baize', 'wrapup']);
  });

  it('忽略非 Skill 工具、非 assistant 事件与无时间戳的行', async () => {
    const p = writeJsonl('b.jsonl', [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-20T10:00:00.000Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      }),
      // user 事件里的 tool_result 回显含相同字样,不能算触发
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-20T10:00:01.000Z',
        message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'baize' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'baize' } }] },
      }),
      'not json at all',
    ]);
    expect(await extractSkillInvocations(p)).toEqual([]);
  });

  it('不含标记的文件直接返回空(预筛路径)', async () => {
    const p = writeJsonl('c.jsonl', [JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T10:00:00.000Z' })]);
    expect(await extractSkillInvocations(p)).toEqual([]);
  });

  it('按事件时间戳归到本地日,不是文件时间', async () => {
    const ts = '2026-08-20T10:00:00.000Z';
    const p = writeJsonl('d.jsonl', [line(ts, ['baize'])]);
    const inv = await extractSkillInvocations(p);
    expect(inv[0]!.day).toBe(localDay(Date.parse(ts)));
  });
});

describe('索引增量 — 重扫不能翻倍', () => {
  const rows = (skill: string, day: string, count: number) => [{ skill, day, count, lastAt: 1 }];

  it('同一文件重复写入是替换而非累加', () => {
    const s = new Storage(tmp);
    const f = { path: '/x/a.jsonl', mtime: 1, size: 10 };
    s.replaceSkillInvocations(f, rows('baize', '2026-08-20', 3));
    s.replaceSkillInvocations(f, rows('baize', '2026-08-20', 5));
    expect(s.skillCountsSince('2026-08-01').get('baize')?.count).toBe(5);
    s.close();
  });

  it('不同文件的同技能同日相加', () => {
    const s = new Storage(tmp);
    s.replaceSkillInvocations({ path: '/x/a.jsonl', mtime: 1, size: 1 }, rows('baize', '2026-08-20', 3));
    s.replaceSkillInvocations({ path: '/x/b.jsonl', mtime: 1, size: 1 }, rows('baize', '2026-08-20', 4));
    expect(s.skillCountsSince('2026-08-01').get('baize')?.count).toBe(7);
    s.close();
  });

  it('指纹随写入更新,未变的文件可据此跳过', () => {
    const s = new Storage(tmp);
    s.replaceSkillInvocations({ path: '/x/a.jsonl', mtime: 42, size: 99 }, rows('baize', '2026-08-20', 1));
    expect(s.skillScanFingerprints().get('/x/a.jsonl')).toEqual({ mtime: 42, size: 99 });
    s.close();
  });

  it('文件消失后 prune 连计数一起清掉', () => {
    const s = new Storage(tmp);
    s.replaceSkillInvocations({ path: '/x/a.jsonl', mtime: 1, size: 1 }, rows('baize', '2026-08-20', 3));
    s.replaceSkillInvocations({ path: '/x/b.jsonl', mtime: 1, size: 1 }, rows('baize', '2026-08-20', 4));
    expect(s.pruneSkillScanFiles(new Set(['/x/b.jsonl']))).toBe(1);
    expect(s.skillCountsSince('2026-08-01').get('baize')?.count).toBe(4);
    s.close();
  });
});

describe('窗口与最近触发', () => {
  it('窗口按日期字符串比较,起始日当天计入', () => {
    const s = new Storage(tmp);
    s.replaceSkillInvocations({ path: '/x/a.jsonl', mtime: 1, size: 1 }, [
      { skill: 'baize', day: '2026-08-10', count: 1, lastAt: 100 },
      { skill: 'baize', day: '2026-08-20', count: 2, lastAt: 200 },
    ]);
    expect(s.skillCountsSince('2026-08-20').get('baize')?.count).toBe(2); // 边界当天算在内
    expect(s.skillCountsSince('2026-08-21').get('baize')).toBeUndefined();
    s.close();
  });

  it('最近触发取全历史最大值,不受窗口限制', () => {
    const s = new Storage(tmp);
    s.replaceSkillInvocations({ path: '/x/a.jsonl', mtime: 1, size: 1 }, [
      { skill: 'baize', day: '2026-05-01', count: 1, lastAt: 500 },
      { skill: 'baize', day: '2026-08-20', count: 1, lastAt: 900 },
    ]);
    expect(s.skillLastUsed().get('baize')).toBe(900);
    s.close();
  });

  it('逐日计数按日聚合,跨文件相加', () => {
    const s = new Storage(tmp);
    s.replaceSkillInvocations({ path: '/x/a.jsonl', mtime: 1, size: 1 }, [
      { skill: 'baize', day: '2026-08-20', count: 2, lastAt: 1 },
    ]);
    s.replaceSkillInvocations({ path: '/x/b.jsonl', mtime: 1, size: 1 }, [
      { skill: 'baize', day: '2026-08-20', count: 3, lastAt: 1 },
      { skill: 'baize', day: '2026-08-21', count: 1, lastAt: 1 },
    ]);
    const daily = s.skillDailyCounts('baize', '2026-08-01');
    expect(daily.get('2026-08-20')).toBe(5);
    expect(daily.get('2026-08-21')).toBe(1);
    s.close();
  });
});

describe('插件命名空间 — 裸名要能对上带前缀的记录', () => {
  it('裸名解析到 plugin:skill 形式的键', () => {
    const s = new Storage(tmp);
    s.replaceSkillInvocations({ path: '/x/a.jsonl', mtime: 1, size: 1 }, [
      { skill: 'claude-hud:setup', day: '2026-08-20', count: 2, lastAt: 1 },
    ]);
    expect(s.skillResolveKey('setup')).toBe('claude-hud:setup');
    s.close();
  });

  it('精确命中优先于前缀匹配', () => {
    const s = new Storage(tmp);
    s.replaceSkillInvocations({ path: '/x/a.jsonl', mtime: 1, size: 1 }, [
      { skill: 'setup', day: '2026-08-20', count: 1, lastAt: 1 },
      { skill: 'claude-hud:setup', day: '2026-08-20', count: 9, lastAt: 1 },
    ]);
    expect(s.skillResolveKey('setup')).toBe('setup');
    s.close();
  });

  it('从未触发的技能解析为 null', () => {
    const s = new Storage(tmp);
    expect(s.skillResolveKey('never-used')).toBeNull();
    s.close();
  });
});
