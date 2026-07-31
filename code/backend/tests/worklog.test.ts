import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorklogMd, scanWorklog } from '../src/adapters/worklog.js';
import { normalizeProject, queryWorklog, sameProject } from '../src/services/worklog.js';

let dir: string;

/** 一张完整的正常卡(格式对齐 wrapup skill 模板) */
const FULL = `---
name: 2026-07-31-antifraud-skills-workflow-nan-prompt
date: 2026-07-31
project: antifraud_skills
task: workflow prompt 裸反引号致 genPrompt 返回 NaN
branch: feature/legacy-evidence-completeness
commits: [f653895, 9b8e0d4]
mr: https://gitlab.example.com/mr/337
refs: [/tmp/replay-v6/.headless-raw.json]
status: merged
session: dc7357c9-8007-4540-9767-dce0537ba678
covers_until: 2026-07-31T15:00:00Z
---

## 问题
narrative 是「未收到有效任务输入」,sub-agent 收到的 prompt 是字面量 "NaN"。

## 结论
裸反引号提前闭合模板字符串,剩余 ** 被解析成幂运算 → NaN。

## 排除项
- 不是 workflow.js 在 main 上有变动:git diff 无输出。
- 不是 headless CLI 侧问题:is_error 为 false。

## 已知残留
- 求值门只覆盖 genPrompt,judge prompt 未纳入。

## 关键决策
- 修完立刻加门而不是只改措辞。

## 涉及文件
- baize/evals/reporter_eval.workflow.js — 措辞改中文引号
`;

/** frontmatter 语法坏掉:仍须出卡,字段走文件名兜底 */
const BROKEN_FM = `---
date: 2026-07-30
task: [未闭合的数组
project: xuanji
---

## 结论
这张卡的 frontmatter 是坏的,但正文仍应可读。
`;

/** 完全没有 frontmatter、段落名也不认识:全文进 raw,绝不丢卡 */
const NO_FM = `# 随手记

今天把那个 bug 修了,没按模板写。
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-worklog-'));
  const m = path.join(dir, 'worklog', '2026', '07');
  fs.mkdirSync(m, { recursive: true });
  fs.writeFileSync(path.join(m, '2026-07-31-antifraud-skills-workflow-nan-prompt.md'), FULL);
  fs.writeFileSync(path.join(m, '2026-07-30-xuanji-broken-fm.md'), BROKEN_FM);
  fs.writeFileSync(path.join(m, '2026-07-29-xuanji-no-fm.md'), NO_FM);
  fs.writeFileSync(path.join(dir, 'worklog', 'INDEX.md'), '- 索引不是卡片\n');
  // 非年份目录不应被扫进来
  fs.mkdirSync(path.join(dir, 'worklog', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'worklog', 'drafts', 'x.md'), FULL);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('parseWorklogMd', () => {
  it('完整卡:frontmatter 与六段正文全部解析', async () => {
    const c = (await parseWorklogMd(
      path.join(dir, 'worklog', '2026', '07', '2026-07-31-antifraud-skills-workflow-nan-prompt.md'),
    ))!;
    expect(c.date).toBe('2026-07-31');
    expect(c.project).toBe('antifraud_skills');
    expect(c.status).toBe('merged');
    expect(c.commits).toEqual(['f653895', '9b8e0d4']);
    expect(c.session).toBe('dc7357c9-8007-4540-9767-dce0537ba678');
    expect(c.coversUntil).toBe('2026-07-31T15:00:00Z');
    expect(c.degraded).toBe(false);
    expect(c.sections.problem).toContain('NaN');
    expect(c.sections.excluded).toHaveLength(2);
    expect(c.sections.residue).toHaveLength(1);
    expect(c.sections.decisions).toHaveLength(1);
    expect(c.sections.files).toHaveLength(1);
    expect(c.sections.raw).toBeUndefined();
  });

  it('frontmatter 坏掉:标 degraded 但不丢卡,日期走文件名兜底', async () => {
    const c = (await parseWorklogMd(path.join(dir, 'worklog', '2026', '07', '2026-07-30-xuanji-broken-fm.md')))!;
    expect(c.degraded).toBe(true);
    expect(c.date).toBe('2026-07-30'); // 来自文件名
    expect(c.status).toBe('unknown');
    expect(c.sections.conclusion).toContain('正文仍应可读');
  });

  it('无 frontmatter 且段落名不认识:全文落 raw', async () => {
    const c = (await parseWorklogMd(path.join(dir, 'worklog', '2026', '07', '2026-07-29-xuanji-no-fm.md')))!;
    expect(c.degraded).toBe(true);
    expect(c.sections.raw).toContain('今天把那个 bug 修了');
    expect(c.sections.conclusion).toBeUndefined();
  });

  it('文件不存在返回 null,不抛', async () => {
    expect(await parseWorklogMd(path.join(dir, 'nope.md'))).toBeNull();
  });
});

describe('scanWorklog', () => {
  it('只扫 YYYY/MM 层级,跳过 INDEX.md 与非年份目录,按日期倒序', async () => {
    const cards = await scanWorklog(dir);
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.date)).toEqual(['2026-07-31', '2026-07-30', '2026-07-29']);
  });

  it('worklog 目录不存在时返回空数组,不抛', async () => {
    expect(await scanWorklog(path.join(dir, 'not-there'))).toEqual([]);
  });
});

describe('项目 slug 归一化', () => {
  it('下划线与短横线视为同一项目(卡片用下划线,history 目录名用短横线)', () => {
    expect(normalizeProject('antifraud_skills')).toBe('antifraud-skills');
    expect(sameProject('antifraud_skills', 'antifraud-skills')).toBe(true);
    expect(sameProject('xuanji', 'baize')).toBe(false);
  });
});

describe('queryWorklog', () => {
  // config.claudeDir 在模块加载时定型,这里只保证真实目录下不抛;
  // 过滤逻辑本身由上面基于 fixture 的 scanWorklog 用例覆盖。
  it('空条件读真实 claudeDir 不抛(worklog 目录可能根本不存在)', async () => {
    await expect(queryWorklog({})).resolves.toBeInstanceOf(Array);
  });
});
