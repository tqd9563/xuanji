import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setPluginEnabled, type ExecFn } from '../src/adapters/plugins-cli.js';

const fake = (out: string, fail = false) => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: ExecFn = async (_f, args, opts) => {
    calls.push({ args, env: opts.env });
    if (fail) throw Object.assign(new Error('exit 1'), { stdout: out });
    return { stdout: out, stderr: '' };
  };
  return { exec, calls };
};

describe('setPluginEnabled(铁律例外②:插件启停)', () => {
  it('调用 claude plugin disable <id> --scope user --json,outcome=ok 即成功', async () => {
    const f = fake('{"outcome":"ok"}\n');
    const r = await setPluginEnabled(path.join(os.homedir(), '.claude'), 'watch@claude-video', false, f.exec);
    expect(r.ok).toBe(true);
    expect(f.calls[0]!.args).toEqual(['plugin', 'disable', 'watch@claude-video', '--scope', 'user', '--json']);
    // 默认目录不改 CLI 配置根
    expect(f.calls[0]!.env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });

  it('非默认 claudeDir 时把 CLAUDE_CONFIG_DIR 指过去(测试 / 隔离验证不碰真实配置)', async () => {
    const f = fake('{"outcome":"ok"}');
    await setPluginEnabled('/tmp/fake-claude', 'a@b', true, f.exec);
    expect(f.calls[0]!.args[1]).toBe('enable');
    expect(f.calls[0]!.env.CLAUDE_CONFIG_DIR).toBe('/tmp/fake-claude');
  });

  it('已处于目标状态视为成功;其它失败把 CLI 的 message 透出', async () => {
    const already = fake('{"outcome":"failed","alreadyInGoalState":true}', true);
    expect((await setPluginEnabled('/tmp/x', 'a@b', false, already.exec)).ok).toBe(true);
    const bad = fake('{"outcome":"failed","message":"Plugin not found"}', true);
    expect(await setPluginEnabled('/tmp/x', 'a@b', false, bad.exec)).toEqual({ ok: false, error: 'Plugin not found' });
  });
});
