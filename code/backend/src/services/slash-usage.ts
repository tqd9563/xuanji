/**
 * 斜杠命令的使用频率:联想面板的排序依据。
 *
 * 两个来源合并,都是只读:
 *  ① 会话转录里的 `<command-name>` 信封 —— CLI 每展开一条斜杠命令就落一条,
 *     这是「用户真的用过」的唯一可靠证据(/model /compact /clear 压根不经过模型,
 *     数模型侧的 Skill 工具调用会把它们全漏掉);
 *  ② 璇玑派发库里的提示词 —— /btw /wd /resume 这类璇玑自己拦截的命令不进 CLI 转录,
 *     只在自有库里留痕。
 *
 * ②的正文是任意用户输入,以 `/` 开头的绝大多数其实是文件路径(实测生产库里
 * `/Users/…/xxx.png,这个图片可以帮我…` 这类占多数),所以只认「已在命令目录里」的名字,
 * 路径不会被算成命令。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { extractCommandInvocations } from '../adapters/claude-dir.js';
import type { Storage } from '../storage/db.js';

/** 命令名 → 使用次数 */
export type UsageCounts = Record<string, number>;

/**
 * 新近度加成:近 30 天内的调用额外计一次权重,让「最近在用的」压过「历史上用过很多次但已经不用的」。
 * 不做指数衰减 —— 排序只要一个稳定的相对次序,衰减曲线的参数调不出可验证的对错。
 */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_BONUS = 1;

/** 扫描窗口:只看近半年的会话文件,更早的对「现在常用什么」没有参考价值,也省 IO */
const SCAN_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * 按文件缓存的提取结果:mtime + size 没变就直接复用,不再读文件。
 *
 * 2026-09-23 实测冷扫描(Promise.all 并发读完近半年全部转录,每个文件同步 split/parse)
 * 在后端进程里把事件循环堵了累计 4.3~5.8s、单次最长 2.3s;缓存 10 分钟一过期,下一个
 * 打开会话的请求就撞上这次扫描,页面里 replay/看板/旁路记录全部一起慢 3~4s——用户说的
 * 「隔一阵再打开会话,内容迟迟不出来」就是它。常态下变化的只有正在写的那几个文件。
 */
const fileCache = new Map<string, { mtimeMs: number; size: number; hits: { name: string; at: number }[] }>();

/** 让出事件循环:逐个文件处理时每处理完一个就让其它请求插队 */
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/** ~/.claude/projects 下 mtime 落在窗口内的会话文件。按 mtime 过滤即可:
 *  一个半年没动过的会话文件里不会有新的命令调用。 */
async function recentSessionFiles(sinceMs: number): Promise<{ fp: string; mtimeMs: number; size: number }[]> {
  const root = path.join(config.claudeDir, 'projects');
  const dirs = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: { fp: string; mtimeMs: number; size: number }[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const full = path.join(root, d.name);
    const files = await fsp.readdir(full).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(full, f);
      const st = await fsp.stat(fp).catch(() => null);
      if (st && st.mtimeMs >= sinceMs) out.push({ fp, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function bump(counts: UsageCounts, name: string, at: number, now: number): void {
  counts[name] = (counts[name] ?? 0) + 1 + (now - at <= RECENT_MS ? RECENT_BONUS : 0);
}

/**
 * 统计使用频率。`known` 是当前命令目录里的名字集合,用于把派发库里的文件路径挡在外面。
 */
export async function countSlashUsage(storage: Storage, known: ReadonlySet<string>): Promise<UsageCounts> {
  const now = Date.now();
  const counts: UsageCounts = {};

  // ① CLI 转录:逐个文件顺序处理(不并发),没变的文件走缓存,变了的读完就让出事件循环
  const files = await recentSessionFiles(now - SCAN_MS);
  const alive = new Set<string>();
  for (const f of files) {
    alive.add(f.fp);
    let entry = fileCache.get(f.fp);
    if (!entry || entry.mtimeMs !== f.mtimeMs || entry.size !== f.size) {
      const hits = await extractCommandInvocations(f.fp).catch(() => []);
      entry = { mtimeMs: f.mtimeMs, size: f.size, hits };
      fileCache.set(f.fp, entry);
      await yieldLoop();
    }
    for (const h of entry.hits) bump(counts, h.name, h.at, now);
  }
  for (const k of fileCache.keys()) if (!alive.has(k)) fileCache.delete(k); // 滑出窗口/被删的文件

  // ② 璇玑自有库(拦截式命令只在这里留痕)
  for (const p of storage.recentPrompts(now - SCAN_MS)) {
    const m = /^\/([A-Za-z0-9:_-]+)(\s|$)/.exec(p.display);
    if (m && known.has(m[1]!)) bump(counts, m[1]!, p.at, now);
  }

  return counts;
}

/** 把使用次数贴到目录条目上(不改变顺序,排序交给前端) */
export function applyUsage<T extends { name: string }>(cmds: T[], counts: UsageCounts): (T & { uses: number })[] {
  return cmds.map((c) => ({ ...c, uses: counts[c.name] ?? 0 }));
}

/** 仅测试用:清空按文件缓存 */
export function _resetSlashUsageFileCache(): void {
  fileCache.clear();
}
