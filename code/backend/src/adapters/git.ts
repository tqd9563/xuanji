/** git 状态探测(公开格式,但属外部进程调用,归 adapter 层)。非 git 目录返回 null。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitStatus } from '../types.js';

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, timeout: 5_000 });
    return stdout;
  } catch {
    return null;
  }
}

export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  const branchOut = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchOut === null) return null;
  const branch = branchOut.trim();

  let modified = 0;
  let untracked = 0;
  const porcelain = await git(cwd, ['status', '--porcelain']);
  if (porcelain !== null) {
    for (const line of porcelain.split('\n')) {
      if (!line) continue;
      if (line.startsWith('??')) untracked++;
      else modified++;
    }
  }

  let ahead: number | null = null;
  const aheadOut = await git(cwd, ['rev-list', '--count', '@{u}..HEAD']);
  if (aheadOut !== null) ahead = Number(aheadOut.trim()) || 0;

  return { branch, modified, untracked, ahead };
}
