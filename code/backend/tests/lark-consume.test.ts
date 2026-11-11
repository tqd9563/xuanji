/**
 * 长连接被占用时的自愈:用一个假的 lark-cli(shell 脚本)模拟「另一个接收方占着」,
 * 断言 consume 报出失败原因后会按间隔重新拉起进程;配置类错误则不重试。
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'lark-consume-'));
const bin = join(dir, 'lark-cli');
const counter = join(dir, 'count');
const mode = join(dir, 'mode');
// 每次被拉起记一笔,按 mode 文件决定输出哪种错误信封,然后退出
writeFileSync(
  bin,
  `#!/bin/sh
echo x >> "${counter}"
if [ "$(cat "${mode}")" = conflict ]; then
  echo '{"ok":false,"error":{"type":"validation","subtype":"failed_precondition","message":"cannot start consumer: another consumer (pid 1) is already running for this subscription"}}' >&2
else
  echo '{"ok":false,"error":{"type":"config","subtype":"missing","message":"profile \\"xuanji\\" not found"}}' >&2
fi
exit 2
`,
);
chmodSync(bin, 0o755);
process.env.XUANJI_LARK_CLI = bin;

// 假时钟只接管被测代码的 setTimeout;等待子进程用真时钟
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
const spawns = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await sleep(10);
};

afterEach(() => {
  vi.useRealTimers();
  writeFileSync(counter, '');
});

describe('长连接被占用', () => {
  it('报出占用原因,并在间隔后自动重新拉起', async () => {
    writeFileSync(mode, 'conflict');
    const { consume, CONFLICT_RETRY_MS } = await import('../src/adapters/lark-cli.js');
    const states: { kind: string; error?: string }[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = consume('card.action.trigger', () => {}, (s) => states.push(s));
    await until(() => states.some((s) => s.kind === 'fail'));
    expect(states.at(-1)).toMatchObject({ kind: 'fail', fatal: true });
    expect(states.at(-1)!.error).toContain('another consumer');
    expect(spawns()).toBe(1);
    vi.advanceTimersByTime(CONFLICT_RETRY_MS);
    await until(() => spawns() === 2);
    expect(spawns()).toBe(2);
    c.stop();
  });

  it('配置类错误不重试', async () => {
    writeFileSync(mode, 'config');
    writeFileSync(counter, '');
    const { consume, CONFLICT_RETRY_MS } = await import('../src/adapters/lark-cli.js');
    const states: { kind: string }[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = consume('card.action.trigger', () => {}, (s) => states.push(s));
    await until(() => states.some((s) => s.kind === 'fail'));
    vi.advanceTimersByTime(CONFLICT_RETRY_MS * 3);
    await sleep(300);
    expect(spawns()).toBe(1);
    c.stop();
  });
});
