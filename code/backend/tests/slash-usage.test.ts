import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 斜杠命令使用频率(联想面板的排序依据)。
 *
 * 实测背景(2026-09-16):本机全量统计 /model 443、/compact 22、/caveman 8,
 * 耗时约 6s —— 所以它绝不能挡在 commands 事件前面(dispatch 侧两段式下发)。
 *
 * 两个来源都要覆盖:CLI 转录里的 `<command-name>` 信封,和璇玑自有库里的派发提示词
 * (/btw /wd 这类璇玑自己拦截的命令不进 CLI 转录,只在自有库留痕)。
 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-usage-'));
vi.mock('../src/config.js', () => ({ config: { claudeDir: tmpHomeRef.dir } }));
const tmpHomeRef = { dir: tmpHome };

const { countSlashUsage, applyUsage, _resetSlashUsageFileCache } = await import('../src/services/slash-usage.js');

function writeSession(project: string, name: string, lines: object[]) {
  const dir = path.join(tmpHome, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

const envelope = (cmd: string, at: number) => ({
  type: 'user',
  timestamp: new Date(at).toISOString(),
  message: { role: 'user', content: `<command-message>x</command-message>\n<command-name>/${cmd}</command-name>` },
});

const noPrompts = { recentPrompts: () => [] } as never;

afterEach(() => {
  fs.rmSync(path.join(tmpHome, 'projects'), { recursive: true, force: true });
  _resetSlashUsageFileCache();
});

describe('countSlashUsage', () => {
  it('数 CLI 转录里的 command-name 信封', async () => {
    const now = Date.now();
    writeSession('-a', 's1', [envelope('model', now - 1000), envelope('model', now - 2000), envelope('compact', now)]);
    const c = await countSlashUsage(noPrompts, new Set());
    expect(c.model).toBeGreaterThan(c.compact!);
  });

  it('近 30 天内的调用多计一次权重:最近在用的压过历史上用得多但已不用的', async () => {
    const now = Date.now();
    const old = now - 100 * 24 * 3600 * 1000;
    writeSession('-a', 's1', [envelope('stale', old), envelope('stale', old), envelope('fresh', now)]);
    // stale 两次陈旧 = 2,fresh 一次新近 = 1 + 1 = 2,打平即证明加成生效(无加成时 stale 必胜)
    expect((await countSlashUsage(noPrompts, new Set())).fresh).toBe(2);
  });

  it('同一行里的信封只数一次:转录里回显与展开各出现一次,重复计数会让命令虚高一倍', async () => {
    const now = Date.now();
    writeSession('-a', 's1', [
      {
        type: 'user',
        timestamp: new Date(now).toISOString(),
        message: { role: 'user', content: '<command-name>/model</command-name> ... <command-name>/model</command-name>' },
      },
    ]);
    expect((await countSlashUsage(noPrompts, new Set())).model).toBe(2); // 1 次 + 新近加成
  });

  it('璇玑自有库里的拦截式命令也计入(它们不进 CLI 转录)', async () => {
    const now = Date.now();
    const storage = { recentPrompts: () => [{ sessionId: null, cwd: '/x', display: '/btw 这个问题', at: now }] } as never;
    expect((await countSlashUsage(storage, new Set(['btw']))).btw).toBe(2);
  });

  it('自有库里以斜杠开头的文件路径不算命令:只认已在目录里的名字', async () => {
    const now = Date.now();
    const storage = {
      recentPrompts: () => [
        { sessionId: null, cwd: '/x', display: '/Users/me/pic.png 帮我抠图', at: now },
        { sessionId: null, cwd: '/x', display: '/tmp/a.log 看下这个', at: now },
      ],
    } as never;
    const c = await countSlashUsage(storage, new Set(['btw']));
    expect(Object.keys(c)).toEqual([]);
  });

  it('无时间戳的行不计入(算不出新近度)', async () => {
    writeSession('-a', 's1', [{ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }]);
    expect((await countSlashUsage(noPrompts, new Set())).model).toBeUndefined();
  });
});

describe('applyUsage', () => {
  it('把次数贴到条目上,没用过的为 0', () => {
    const out = applyUsage([{ name: 'a' }, { name: 'b' }], { a: 7 });
    expect(out).toEqual([{ name: 'a', uses: 7 }, { name: 'b', uses: 0 }]);
  });
});

describe('按文件缓存(不再每次全量重扫)', () => {
  it('mtime 与 size 都没变的文件直接复用上次结果,不重新读', async () => {
    const now = Date.now();
    writeSession('-a', 's1', [envelope('model', now)]);
    const fp = path.join(tmpHome, 'projects', '-a', 's1.jsonl');
    // mtime 固定成整秒:utimes 回拨会丢亚毫秒精度,用原值拨回反而对不上
    const T = Math.floor(now / 1000);
    fs.utimesSync(fp, T, T);
    expect((await countSlashUsage(noPrompts, new Set())).model).toBe(2);
    // 同长度改写内容并把 mtime 拨回同一值:若真的重读,model 会变成 mdoel
    fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace('/model<', '/mdoel<'));
    fs.utimesSync(fp, T, T);
    const c = await countSlashUsage(noPrompts, new Set());
    expect(c.model).toBe(2);
    expect(c.mdoel).toBeUndefined();
  });

  it('文件变了(size 变化)就重读', async () => {
    const now = Date.now();
    writeSession('-a', 's1', [envelope('model', now)]);
    await countSlashUsage(noPrompts, new Set());
    writeSession('-a', 's1', [envelope('model', now), envelope('compact', now)]);
    expect((await countSlashUsage(noPrompts, new Set())).compact).toBe(2);
  });
});
