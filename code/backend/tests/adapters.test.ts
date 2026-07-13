/** Adapter 契约测试:fixture 即契约,CLI 升级破坏格式时这里先红(T1)。 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  decodeProjectDir,
  extractUsage,
  findSessionFile,
  parseReplay,
  readHistory,
  readJobStates,
  scanMemories,
  scanProjectDirs,
  scanSkills,
} from '../src/adapters/claude-dir.js';
import { normalizeState, toAgentSession, type RawAgent } from '../src/adapters/agents-cli.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'claude');
const SID = '11111111-2222-3333-4444-555555555555';

describe('decodeProjectDir', () => {
  it('从 session jsonl 嗅探真实 cwd(路径含连字符也能还原)', async () => {
    const p = await decodeProjectDir(path.join(FIX, 'projects'), '-Users-me-demo-app');
    expect(p).toBe('/Users/me/demo-app');
  });
  it('无 jsonl 时退化为朴素替换', async () => {
    const p = await decodeProjectDir(path.join(FIX, 'projects'), '-Users-me-nothing');
    expect(p).toBe('/Users/me/nothing');
  });
});

describe('parseReplay', () => {
  it('归一化用户/助手/工具事件,回填 tool_result,未知类型降级 raw,坏行计数', async () => {
    const file = await findSessionFile(FIX, SID);
    expect(file).toBeTruthy();
    const replay = await parseReplay(file!, SID);

    // agent-name(改名事件)覆盖 custom-title;二者都不作为 raw 泄漏
    expect(replay.title).toBe('演示会话改名');
    expect(replay.skippedLines).toBe(1); // "this line is not json at all"

    const kinds = replay.events.map((e) => e.kind);
    expect(kinds).toEqual(['user', 'assistant', 'tool', 'assistant', 'assistant', 'raw']);

    const tool = replay.events.find((e) => e.kind === 'tool');
    expect(tool).toMatchObject({ name: 'Grep', input: 'SignalL3' });
    expect((tool as any).output).toContain('l3.go:24');

    const raw = replay.events.find((e) => e.kind === 'raw');
    expect((raw as any).type).toBe('x-future-event');

    // thinking 块不进回放
    expect(JSON.stringify(replay.events)).not.toContain('secret');
  });
});

describe('extractUsage', () => {
  it('按 message.id 去重,同 id 流式重复只算一次', async () => {
    const file = await findSessionFile(FIX, SID);
    const records = await extractUsage(file!);
    expect(records).toHaveLength(2); // msg_001 去重 + msg_002
    const fable = records.find((r) => r.model === 'claude-fable-5')!;
    expect(fable).toMatchObject({ input: 1000, cacheCreation: 2000, cacheRead: 50000, output: 300 });
  });

  it('sinceMs 按记录时间戳过滤:晚于所有记录 → 空,早于则全留(今日成本口径)', async () => {
    const file = await findSessionFile(FIX, SID);
    // fixture 用量记录都在 2026-07-08,给一个更晚的起点应过滤为空
    expect(await extractUsage(file!, Date.parse('2026-07-09T00:00:00Z'))).toHaveLength(0);
    // 更早的起点保留全部
    expect(await extractUsage(file!, Date.parse('2026-07-01T00:00:00Z'))).toHaveLength(2);
  });
});

describe('readHistory', () => {
  it('解析合法行,跳过坏时间戳与非 JSON 行', async () => {
    const entries = await readHistory(FIX);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.display).toContain('高风险 IP');
  });
});

describe('scanProjectDirs / scanMemories', () => {
  it('统计会话与 memory 数,解析 frontmatter 与 [[链接]]', async () => {
    const dirs = await scanProjectDirs(FIX);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatchObject({ sessionCount: 1, memoryCount: 1, path: '/Users/me/demo-app' });

    const mems = await scanMemories(FIX, new Map([['-Users-me-demo-app', '/Users/me/demo-app']]));
    expect(mems).toHaveLength(1);
    expect(mems[0]).toMatchObject({ name: 'demo-fact', type: 'feedback', project: 'demo-app' });
    expect(mems[0]!.links).toEqual(['metric-caliber-first', 'offline-eval']);
  });
});

describe('scanSkills', () => {
  it('user/disabled 双目录扫描,frontmatter 完整解析', async () => {
    const skills = await scanSkills(FIX);
    const on = skills.find((s) => s.name === 'demo-skill')!;
    expect(on).toMatchObject({ enabled: true, source: 'user', version: '2.3.0', allowedTools: 'Bash, Read' });
    const off = skills.find((s) => s.name === 'off-skill')!;
    expect(off).toMatchObject({ enabled: false, userInvocable: false });
  });
  it('跟随 symlink 安装的技能目录', async () => {
    const skills = await scanSkills(FIX);
    expect(skills.find((s) => s.name === 'linked-skill')).toMatchObject({ enabled: true, source: 'user' });
  });
});

describe('moveSkill(铁律例外②)', () => {
  it('启停 = 目录在 skills/ 与 skills-disabled/ 间往返,可逆且拒绝非法名', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-skill-'));
    fs.mkdirSync(path.join(tmp, 'skills', 'toggle-me'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'skills', 'toggle-me', 'SKILL.md'), '---\nname: toggle-me\n---\n');
    const { moveSkill } = await import('../src/adapters/claude-dir.js');

    expect((await moveSkill(tmp, '../evil', false)).ok).toBe(false);
    expect((await moveSkill(tmp, 'toggle-me', true)).ok).toBe(false); // 已在启用态,不能再启用

    const off = await moveSkill(tmp, 'toggle-me', false);
    expect(off.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'skills-disabled', 'toggle-me', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'skills', 'toggle-me'))).toBe(false);

    const on = await moveSkill(tmp, 'toggle-me', true);
    expect(on.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'skills', 'toggle-me', 'SKILL.md'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('readJobStates', () => {
  it('读取 detail/needs/tokens', async () => {
    const jobs = await readJobStates(FIX);
    expect(jobs.get('aaa11111')).toMatchObject({
      state: 'blocked',
      tokens: 131839,
      needs: expect.stringContaining('主推组'),
    });
  });
});

describe('agents-cli 归一化', () => {
  const base: RawAgent = {
    id: 'x',
    cwd: '/Users/me/demo-app',
    kind: 'background',
    startedAt: 1,
    sessionId: 's',
  };
  it('state 归一化覆盖已知值,未知值保守处理', () => {
    expect(normalizeState({ ...base, state: 'blocked' })).toBe('blocked');
    expect(normalizeState({ ...base, state: 'done' })).toBe('done');
    expect(normalizeState({ ...base, state: 'running' })).toBe('running');
    expect(normalizeState({ ...base, state: 'idle' })).toBe('idle');
    expect(normalizeState({ ...base, state: 'weird-new-state' })).toBe('idle');
  });
  it('终端存活的 interactive 会话标记只读', () => {
    const s = toAgentSession({ ...base, kind: 'interactive', pid: process.pid, state: 'running' });
    expect(s.readonly).toBe(true);
    const bg = toAgentSession({ ...base, state: 'running' });
    expect(bg.readonly).toBe(false);
    expect(bg.project).toBe('demo-app');
  });
});
