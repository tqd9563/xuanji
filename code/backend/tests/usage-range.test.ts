/**
 * 用量窗口(today / 7d)与 multica 对比桶的契约测试。
 * usageReport 读的是模块级 config.claudeDir,故本文件先设 env 再动态 import
 * (vitest 默认按文件隔离模块图,不会污染其它测试)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-usage-'));
process.env.XUANJI_CLAUDE_DIR = TMP;

const DAY = 86_400_000;

/** 一条 assistant usage 记录。牌价 fable [5,25] USD/MTok */
function rec(ts: number, id: string, u: Partial<Record<'in' | 'out' | 'cw' | 'cr', number>>) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: {
      id,
      model: 'claude-fable-5',
      usage: {
        input_tokens: u.in ?? 0,
        output_tokens: u.out ?? 0,
        cache_creation_input_tokens: u.cw ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
      },
    },
  });
}

function writeSession(dir: string, sessionId: string, lines: string[]) {
  const d = path.join(TMP, 'projects', dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

let usage: typeof import('../src/services/usage.js');

beforeAll(async () => {
  usage = await import('../src/services/usage.js');
  const now = Date.now();
  const noonToday = new Date();
  noonToday.setHours(12, 0, 0, 0);
  const today = Math.min(noonToday.getTime(), now);
  const threeDaysAgo = today - 3 * DAY;
  const tenDaysAgo = today - 10 * DAY;

  // 开发项目:今天 1M output,3 天前 1M output,10 天前 1M output(窗口外)
  writeSession('-Users-me-demoapp', 'aaaaaaaa-0000-0000-0000-000000000001', [
    rec(today, 'msg-today', { out: 1_000_000 }),
    rec(threeDaysAgo, 'msg-3d', { out: 1_000_000 }),
    rec(tenDaysAgo, 'msg-10d', { out: 1_000_000 }),
  ]);
  // 噪音目录(multica):今天 2M output —— 应只进 noise 桶,不进 projects
  writeSession('-Users-me--multica-workspaces-run-42', 'bbbbbbbb-0000-0000-0000-000000000002', [
    rec(today, 'msg-noise', { out: 2_000_000 }),
  ]);
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('rangeStart 窗口边界', () => {
  it('today = 当日零点;7d = 往前推 6 天的零点(含今日共 7 个自然日)', () => {
    const now = new Date('2026-08-28T21:47:00');
    const today = usage.rangeStart('today', now);
    const week = usage.rangeStart('7d', now);
    expect(new Date(today).getHours()).toBe(0);
    expect(new Date(today).getDate()).toBe(28);
    expect(new Date(week).getDate()).toBe(22);
    expect(Math.round((today - week) / DAY)).toBe(6);
  });
});

describe('isUsageRange 入参校验', () => {
  it('只认 today / 7d', () => {
    expect(usage.isUsageRange('today')).toBe(true);
    expect(usage.isUsageRange('7d')).toBe(true);
    expect(usage.isUsageRange('30d')).toBe(false);
    expect(usage.isUsageRange(undefined)).toBe(false);
  });
});

describe('usageReport 窗口与 multica 对比桶', () => {
  it('today 只计今日;7d 计入 3 天前但不计 10 天前', async () => {
    usage.invalidateUsageCache();
    const today = await usage.usageReport('today');
    const week = await usage.usageReport('7d');

    // fable output 25 USD/MTok:今日 1M = $25,近 7 日 2M = $50(10 天前那条落窗口外)
    expect(today.projects[0]!.totalCostUsd).toBeCloseTo(25);
    expect(week.projects[0]!.totalCostUsd).toBeCloseTo(50);
    expect(today.range).toBe('today');
    expect(week.range).toBe('7d');
    expect(week.since).toBeLessThan(today.since);
  });

  it('multica 目录不进项目明细,只计入 noise 汇总', async () => {
    usage.invalidateUsageCache();
    const r = await usage.usageReport('today');
    expect(r.projects.map((p) => p.project)).toEqual(['demoapp']);
    expect(r.projects.some((p) => /multica/.test(p.project))).toBe(false);
    // 噪音桶:2M output = $50,是开发侧($25)的两倍
    expect(r.noise.costUsd).toBeCloseTo(50);
    expect(r.noise.tokens.inOut).toBe(2_000_000);
    expect(r.totalCostUsd).toBeCloseTo(25);
  });

  it('token 量口径:inOut 含 cacheWrite 不含 cacheRead', async () => {
    usage.invalidateUsageCache();
    writeSession('-Users-me-cacheheavy', 'cccccccc-0000-0000-0000-000000000003', [
      rec(Date.now(), 'msg-cache', { in: 100, out: 200, cw: 300, cr: 999_999 }),
    ]);
    const r = await usage.usageReport('today');
    const p = r.projects.find((x) => x.project === 'cacheheavy')!;
    expect(p.totalTokens.inOut).toBe(600); // 100 + 200 + 300
    expect(p.totalTokens.cacheRead).toBe(999_999);
    expect(p.sessions[0]!.totalTokens.inOut).toBe(600);
  });

  it('narrate-cwd 目录(baize claude -p 叙述会话)同样进 noise 桶,不进项目明细', async () => {
    usage.invalidateUsageCache();
    // 真实形态:~/baize-runs/.narrate-cwd → 编码为 …-baize-runs--narrate-cwd
    writeSession('-Users-me-baize-runs--narrate-cwd', 'ffffffff-0000-0000-0000-000000000006', [
      rec(Date.now(), 'msg-narrate', { out: 500_000 }),
    ]);
    const r = await usage.usageReport('today');
    expect(r.projects.some((p) => /narrate/.test(p.dir))).toBe(false);
    // noise = multica 2M + narrate 0.5M
    expect(r.noise.tokens.inOut).toBe(2_500_000);
  });

  it('目录末段撞名的项目往前多带一段消歧,dir 始终唯一', async () => {
    usage.invalidateUsageCache();
    const now = Date.now();
    // 两个不同项目的目录末段都是 "skills" —— 近一周窗口里这是常态
    writeSession('-Users-me-yuiko-skills', 'dddddddd-0000-0000-0000-000000000004', [
      rec(now, 'msg-y', { out: 1000 }),
    ]);
    writeSession('-Users-me-antifraud-skills', 'eeeeeeee-0000-0000-0000-000000000005', [
      rec(now, 'msg-a', { out: 1000 }),
    ]);
    const r = await usage.usageReport('today');
    const names = r.projects.map((p) => p.project);
    expect(names).toContain('yuiko-skills');
    expect(names).toContain('antifraud-skills');
    expect(names.filter((n) => n === 'skills')).toHaveLength(0);
    // 展示名与 dir 都不许重复:前者影响可读,后者是 React key
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(r.projects.map((p) => p.dir)).size).toBe(r.projects.length);
    // 不撞名的项目保持短名,不受消歧波及
    expect(names).toContain('demoapp');
  });

  it('缓存按 range 分键,不会用今日结果冒充近一周', async () => {
    usage.invalidateUsageCache();
    const t1 = await usage.usageReport('today');
    const w1 = await usage.usageReport('7d');
    const t2 = await usage.usageReport('today'); // 命中缓存
    expect(t2.range).toBe('today');
    expect(t2.totalCostUsd).toBeCloseTo(t1.totalCostUsd);
    expect(w1.totalCostUsd).toBeGreaterThan(t1.totalCostUsd);
  });
});
