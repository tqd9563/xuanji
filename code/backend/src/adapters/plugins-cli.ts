/**
 * 插件启停 —— 包装 `claude plugin enable/disable --scope user --json`。
 * 铁律例外②(2026-11-27 用户批准):界面显式触发 + 二次确认,改 settings.json 的 enabledPlugins,可逆。
 * 不自己改 settings.json:CLI 是这个开关的唯一官方写入方,自己写会漏掉它的校验与后续格式演进。
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = promisify(execFile) as unknown as ExecFn;

export async function setPluginEnabled(
  claudeDir: string,
  id: string,
  enable: boolean,
  exec: ExecFn = defaultExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const env = { ...process.env };
  // 只有璇玑指向非默认目录(测试 / 隔离验证)时才改 CLI 的配置根,默认场景保持 CLI 原生行为
  if (path.resolve(claudeDir) !== path.join(os.homedir(), '.claude')) env.CLAUDE_CONFIG_DIR = claudeDir;
  const args = ['plugin', enable ? 'enable' : 'disable', id, '--scope', 'user', '--json'];
  let stdout = '';
  try {
    stdout = (await exec('claude', args, { timeout: 30_000, env })).stdout;
  } catch (e) {
    // 非 0 退出时 --json 结果仍在 stdout 上
    stdout = (e as { stdout?: string }).stdout ?? '';
    if (!stdout) return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  let res: { outcome?: string; message?: string; alreadyInGoalState?: boolean } = {};
  try {
    res = line ? JSON.parse(line) : {};
  } catch {
    /* 落到下方统一报错 */
  }
  // 已经是目标状态视为成功:界面可能落后于终端里的手动操作
  if (res.outcome === 'ok' || res.alreadyInGoalState) return { ok: true };
  return { ok: false, error: res.message ?? (stdout.trim() || 'claude plugin 无输出') };
}
