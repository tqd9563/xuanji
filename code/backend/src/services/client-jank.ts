import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 前端卡顿记录的落盘:追加到 dataDir/client-jank.jsonl,一行一条。
 * 用途是事后取证(用户说「刚才又卡了」,我读文件定位),不进 sqlite——它是日志不是数据。
 */
const FILE = () => path.join(config.dataDir, 'client-jank.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;

/** 只收白名单字段,长度封顶,别让前端把任意东西写进文件 */
export function sanitizeJank(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.stallMs !== 'number' || !Number.isFinite(b.stallMs)) return null;
  const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
  const strs = (v: unknown, n = 40) => (Array.isArray(v) ? v.slice(0, n).map((x) => str(x, 300)) : []);
  return {
    at: str(b.at, 40) || new Date().toISOString(),
    stallMs: Math.round(b.stallMs),
    view: str(b.view, 40),
    visibility: str(b.visibility, 20),
    sinceInteractionMs: typeof b.sinceInteractionMs === 'number' ? Math.round(b.sinceInteractionMs) : null,
    interaction: b.interaction && typeof b.interaction === 'object' ? JSON.parse(JSON.stringify(b.interaction).slice(0, 600)) : null,
    inflight: strs(b.inflight),
    recent: Array.isArray(b.recent) ? b.recent.slice(0, 30) : [],
    scripts: strs(b.scripts),
    ua: str(b.ua, 200),
  };
}

export async function appendJank(rec: Record<string, unknown>, file = FILE()): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // 超过上限就截半:保留后一半,记录器只是取证用,不需要无限历史
  try {
    const st = await fs.promises.stat(file);
    if (st.size > MAX_BYTES) {
      const lines = (await fs.promises.readFile(file, 'utf8')).split('\n');
      await fs.promises.writeFile(file, lines.slice(Math.floor(lines.length / 2)).join('\n'));
    }
  } catch {
    /* 文件不存在 */
  }
  await fs.promises.appendFile(file, JSON.stringify(rec) + '\n');
}

export async function readJank(limit: number, file = FILE()): Promise<Record<string, unknown>[]> {
  let text = '';
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out.slice(-limit);
}
