/**
 * 任务总结(worklog)服务:列表、筛选、按周取卡。
 * 数据源恒为 ~/.claude/worklog 的 md 文件(source of truth),这里只做缓存与过滤,不写盘。
 */
import { config } from '../config.js';
import { scanWorklog } from '../adapters/worklog.js';
import type { WorklogCard } from '../types.js';

let cached: { at: number; cards: WorklogCard[] } | null = null;
const CACHE_MS = 30_000;

export async function listWorklog(): Promise<WorklogCard[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.cards;
  const cards = await scanWorklog(config.claudeDir);
  cached = { at: Date.now(), cards };
  return cards;
}

export function invalidateWorklogCache() {
  cached = null;
}

export interface WorklogQuery {
  /** 窗口起止(epoch ms),按卡片 date 的本地自然日判定 */
  start?: number;
  end?: number;
  project?: string;
  status?: WorklogCard['status'];
  /** 全文关键词:任务/结论/排除项/残留/项目 */
  q?: string;
}

export async function queryWorklog(f: WorklogQuery): Promise<WorklogCard[]> {
  const all = await listWorklog();
  const needle = f.q?.trim().toLowerCase();
  return all.filter((c) => {
    if (f.status && c.status !== f.status) return false;
    if (f.project && !sameProject(c.project, f.project)) return false;
    if (f.start !== undefined || f.end !== undefined) {
      const ts = dateToTs(c.date);
      if (ts === null) return false;
      if (f.start !== undefined && ts < dayStart(f.start)) return false;
      if (f.end !== undefined && ts > f.end) return false;
    }
    if (needle && !haystack(c).includes(needle)) return false;
    return true;
  });
}

/** 本周(或任意窗口)卡片:周报取材入口 */
export async function worklogForWeek(start: number, end: number): Promise<WorklogCard[]> {
  return queryWorklog({ start, end });
}

/**
 * 项目 slug 归一化比较。卡里 project 用下划线(antifraud_skills),
 * 而 history 的项目目录名/展示名常是短横线(antifraud-skills),跨源匹配必须归一。
 */
export function normalizeProject(p: string): string {
  return p.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

export function sameProject(a: string, b: string): boolean {
  return normalizeProject(a) === normalizeProject(b);
}

/** 'YYYY-MM-DD' → 当地当日 00:00 的 epoch ms;格式不对返回 null(卡仍在列表里,只是不参与窗口过滤) */
function dateToTs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function haystack(c: WorklogCard): string {
  const s = c.sections;
  return [
    c.task,
    c.project,
    c.branch ?? '',
    s.problem ?? '',
    s.conclusion ?? '',
    ...s.excluded,
    ...s.residue,
    ...s.decisions,
    ...s.files,
    s.raw ?? '',
  ]
    .join('\n')
    .toLowerCase();
}
