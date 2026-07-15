/**
 * 周回顾:窗口内「我在哪些会话下活跃过」的聚合。
 * 活跃口径 = 我发出的 prompt(history.jsonl ∪ 璇玑派发流水),不是会话文件 mtime——
 * 后台 agent 自己跑不算「我活跃」。成本按记录时间窗过滤;commits 为窗口内所有分支提交题目。
 */
import { config } from '../config.js';
import { extractSessionTitle, extractUsage, mapSessionFiles, readHistory } from '../adapters/claude-dir.js';
import { gitLogSubjects } from '../adapters/git.js';
import { costUsd } from './usage.js';
import type { HistoryEntry, ReviewProject, ReviewSession, WeeklyReview } from '../types.js';
import type { Storage } from '../storage/db.js';

const DAY = 86_400_000;
/** 每会话 prompt 样本封顶(超出截断,caliber 说明) */
const PROMPTS_PER_SESSION = 30;
/** 单条 prompt 样本截断长度 */
const PROMPT_CHARS = 200;

export interface SourcedEntry extends HistoryEntry {
  source: 'terminal' | 'web';
}

/** 窗口按本地日界切桶:首桶 = start 所在自然日 */
export function dayBucketOf(ts: number, start: number): number {
  const d0 = new Date(start);
  d0.setHours(0, 0, 0, 0);
  return Math.floor((ts - d0.getTime()) / DAY);
}

export function dayCountOf(start: number, end: number): number {
  return dayBucketOf(end, start) + 1;
}

export interface WeekAggregation {
  projects: {
    path: string;
    prompts: number;
    days: number[];
    sessions: Omit<ReviewSession, 'title' | 'costUsd'>[];
  }[];
  totals: { prompts: number; sessions: number; projects: number; activeDays: number };
  dayCount: number;
}

/**
 * 纯聚合(不做 IO):entries → 项目 → 会话两级分组。
 * entries 需已按窗口过滤;无 sessionId 的条目归入项目内 '(未关联)' 伪会话,prompt 总数不失真。
 */
export function aggregateWeek(entries: SourcedEntry[], start: number, end: number): WeekAggregation {
  const dayCount = dayCountOf(start, end);
  const activeDayIdx = new Set<number>();
  const byProject = new Map<string, Map<string, Omit<ReviewSession, 'title' | 'costUsd'>>>();
  const projDays = new Map<string, number[]>();
  let prompts = 0;

  for (const e of [...entries].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.timestamp < start || e.timestamp > end || !e.project) continue;
    const bucket = Math.min(dayCount - 1, Math.max(0, dayBucketOf(e.timestamp, start)));
    prompts++;
    activeDayIdx.add(bucket);

    let sessions = byProject.get(e.project);
    if (!sessions) byProject.set(e.project, (sessions = new Map()));
    let days = projDays.get(e.project);
    if (!days) projDays.set(e.project, (days = new Array(dayCount).fill(0) as number[]));
    days[bucket] = (days[bucket] ?? 0) + 1;

    const key = e.sessionId || '(未关联)';
    let s = sessions.get(key);
    if (!s) {
      sessions.set(
        key,
        (s = {
          sessionId: e.sessionId,
          prompts: 0,
          firstAt: e.timestamp,
          lastAt: e.timestamp,
          days: new Array(dayCount).fill(0) as number[],
          promptTexts: [],
          source: e.source,
        }),
      );
    }
    s.prompts++;
    s.lastAt = e.timestamp;
    s.days[bucket] = (s.days[bucket] ?? 0) + 1;
    if (e.source === 'web') s.source = 'web'; // 同会话混合来源时以 web 标记(璇玑派发过即算)
    if (s.promptTexts.length < PROMPTS_PER_SESSION && e.display.trim()) {
      s.promptTexts.push(e.display.replace(/\s+/g, ' ').slice(0, PROMPT_CHARS));
    }
  }

  const projects = [...byProject.entries()]
    .map(([path, sessions]) => ({
      path,
      prompts: projDays.get(path)!.reduce((a, b) => a + b, 0),
      days: projDays.get(path)!,
      sessions: [...sessions.values()].sort((a, b) => b.prompts - a.prompts),
    }))
    .sort((a, b) => b.prompts - a.prompts);

  let sessionCount = 0;
  for (const p of projects) sessionCount += p.sessions.length;

  return {
    projects,
    totals: { prompts, sessions: sessionCount, projects: projects.length, activeDays: activeDayIdx.size },
    dayCount,
  };
}

// ---------- IO 包装 ----------

let cache: { key: string; at: number; report: WeeklyReview } | null = null;
const CACHE_MS = 60_000;

export function invalidateWeeklyReviewCache() {
  cache = null;
}

export async function weeklyReview(storage: Storage, start: number, end: number): Promise<WeeklyReview> {
  const key = `${start}:${end}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.report;

  // 1. 活跃流并集:history.jsonl(终端)∪ dispatch_prompts(璇玑派发,SDK 不写 history.jsonl)
  const fileHistory = await readHistory(config.claudeDir, { sinceMs: start });
  const webIds = storage.webDispatchedIds();
  const entries: SourcedEntry[] = [
    ...fileHistory.map((e) => ({ ...e, source: (webIds.has(e.sessionId) ? 'web' : 'terminal') as 'web' | 'terminal' })),
    ...storage.recentPrompts(start).map((p) => ({
      display: p.display,
      timestamp: p.at,
      project: p.cwd,
      sessionId: p.sessionId ?? '',
      source: 'web' as const,
    })),
  ].filter(
    (e) =>
      e.timestamp <= end && !config.projectNoisePatterns.some((re) => re.test(e.project)),
  );

  const agg = aggregateWeek(entries, start, end);

  // 2. 会话名解析:派发名 + 重命名覆盖优先,缺失从转录提默认名,兜底短 id
  const nameMap = new Map<string, string>();
  for (const d of storage.allDispatches()) if (d.name) nameMap.set(d.sessionId, d.name);
  for (const [id, n] of storage.sessionNames()) nameMap.set(id, n);
  const allIds = agg.projects.flatMap((p) => p.sessions.map((s) => s.sessionId)).filter(Boolean);
  const files = await mapSessionFiles(config.claudeDir, allIds);

  // 3. 逐项目装配:标题、窗口内成本、git commits
  const projects: ReviewProject[] = await Promise.all(
    agg.projects.map(async (p) => {
      const sessions: ReviewSession[] = await Promise.all(
        p.sessions.map(async (s) => {
          const file = s.sessionId ? files.get(s.sessionId) : undefined;
          const title =
            nameMap.get(s.sessionId) ||
            (file && (await extractSessionTitle(file))) ||
            (s.sessionId ? s.sessionId.slice(0, 8) : '(未关联)');
          const records = file ? await extractUsage(file, start, end) : [];
          return { ...s, title, costUsd: records.reduce((sum, r) => sum + costUsd(r), 0) };
        }),
      );
      return {
        project: p.path.split('/').filter(Boolean).pop() ?? p.path,
        path: p.path,
        prompts: p.prompts,
        days: p.days,
        costUsd: sessions.reduce((sum, s) => sum + s.costUsd, 0),
        commits: (await gitLogSubjects(p.path, start, end)) ?? [],
        sessions,
      };
    }),
  );

  const report: WeeklyReview = {
    range: { start, end, dayCount: agg.dayCount },
    totals: { ...agg.totals, costUsd: projects.reduce((sum, p) => sum + p.costUsd, 0) },
    projects,
    caliber: {
      active: '活跃 = 我发出的 prompt(history.jsonl ∪ 璇玑派发流水,本地时区日界),后台 agent 自跑不计',
      prompts: `prompt 样本每会话封顶 ${PROMPTS_PER_SESSION} 条、每条 ${PROMPT_CHARS} 字符,计数不受封顶影响`,
      cost: '窗口内 assistant usage 按 message.id 去重、按记录时间过滤;牌价口径同 /usage/today',
      commits: 'git log --all --no-merges 窗口内题目,封顶 50 条;含所有分支(worktree 开发含在内)',
    },
    computedAt: Date.now(),
  };
  cache = { key, at: Date.now(), report };
  return report;
}
