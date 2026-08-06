/**
 * 待办服务:临时想法收集箱的读写与项目解析。
 * 数据全在自有 SQLite(~/.claude 不涉及),故这里可以写——只读铁律约束的是他人格式的文件。
 *
 * 项目解析是本服务唯一有难度的部分:web 界面传的是绝对路径(已经在 /wd 弹窗里选好了),
 * 而 Raycast 等外部脚本只能传一个手打的短名(「xj」「baize」),需要在服务端宽松匹配。
 */
import { config } from '../config.js';
import { scanProjectDirs } from '../adapters/claude-dir.js';
import type { Todo } from '../types.js';

/** 项目目录列表缓存:解析一条待办不值得每次都扫盘 */
let cached: { at: number; paths: string[] } | null = null;
const CACHE_MS = 60_000;

async function knownProjectPaths(): Promise<string[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.paths;
  const dirs = await scanProjectDirs(config.claudeDir);
  const paths = dirs
    .filter((p) => p.exists && !config.projectNoisePatterns.some((re) => re.test(p.path) || re.test(p.encodedDir)))
    .map((p) => p.path);
  cached = { at: Date.now(), paths };
  return paths;
}

export function invalidateTodoProjectCache() {
  cached = null;
}

/** 路径末段短名(与前端 ProjChip 同一口径) */
export function shortName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}

/** 子序列匹配:query 的字符按序出现在 target 中即命中(入参均已小写) */
function isSubseq(q: string, t: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/**
 * 宽松解析项目:绝对路径直接采信,否则按短名分层打分匹配已知项目目录。
 * 100 前缀 > 80 中段 > 60 短名子序列(「xj」→ xuanji);匹配不上返回 null 存「未指定」,
 * 而不是报错——外部速记的第一要务是「记下来」,归属可以事后在界面补。
 * 打分口径与前端 WdPalette 一致,避免同一个词在两处给出不同答案。
 */
export async function resolveProject(input?: string | null): Promise<{ cwd: string | null; project: string | null }> {
  const raw = (input ?? '').trim();
  if (!raw) return { cwd: null, project: null };
  if (raw.startsWith('/')) return { cwd: raw, project: shortName(raw) };

  const q = raw.toLowerCase();
  const paths = await knownProjectPaths();
  let best: { path: string; score: number } | null = null;
  for (const p of paths) {
    const name = shortName(p).toLowerCase();
    const idx = name.indexOf(q);
    const score = idx === 0 ? 100 : idx > 0 ? 80 : isSubseq(q, name) ? 60 : null;
    if (score === null) continue;
    if (!best || score > best.score) best = { path: p, score };
  }
  return best ? { cwd: best.path, project: shortName(best.path) } : { cwd: null, project: null };
}

/** 标题上限:待办是一句话想法,长文属于 prompt,该进派发页而不是收集箱 */
export const TITLE_MAX = 500;

export function validateTitle(title: unknown): { error: string } | null {
  if (typeof title !== 'string' || !title.trim()) return { error: 'title 不能为空' };
  if (title.trim().length > TITLE_MAX) return { error: `title 不能超过 ${TITLE_MAX} 字` };
  return null;
}

export function isTodoStatus(v: unknown): v is Todo['status'] {
  return v === 'open' || v === 'doing' || v === 'done';
}

/** 状态流转的时间戳:开工记 startedAt、完成记 doneAt;回退到 open 则两者清空(重新开始) */
export function statusPatch(status: Todo['status']): Partial<Todo> {
  const now = Date.now();
  if (status === 'doing') return { status, startedAt: now, doneAt: null };
  if (status === 'done') return { status, doneAt: now };
  return { status, startedAt: null, doneAt: null };
}
