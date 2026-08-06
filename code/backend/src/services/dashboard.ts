import { config } from '../config.js';
import { readHistory } from '../adapters/claude-dir.js';
import { cliVersion, readCrontab } from '../adapters/agents-cli.js';
import { sessionsBoard } from './sessions.js';
import { heatBuckets } from './projects.js';
import { todayUsage } from './usage.js';
import type { AgentSession, HistoryEntry } from '../types.js';
import type { Storage } from '../storage/db.js';

export interface Dashboard {
  needsAttention: AgentSession[];
  running: AgentSession[];
  /** 「待验收」候选(空闲/已完成且有产出时间):已读与否由前端本地已读表判定 */
  reviewCandidates: AgentSession[];
  strip: {
    todayPrompts: number;
    todayTokensInOut: number;
    todayCacheRead: number;
    todayCostUsd: number;
    activeProjects: number;
    systemCrons: number;
    /** 应用内定时任务(M3):normal = pending/running/blocked/done 之和(排程健康),fused/missed 单列出来提醒处理 */
    scheduledJobs: { normal: number; fused: number; missed: number };
  };
  timeline: { time: number; project: string; message: string }[];
  heat: { project: string; days: number[] }[];
  usage: Awaited<ReturnType<typeof todayUsage>>;
  caliber: Record<string, string>;
  health: { cli: string | null; agentsOk: boolean };
}

const DAY = 86_400_000;

export async function dashboard(storage?: Storage): Promise<Dashboard> {
  const since = Date.now() - 8 * DAY;
  const [fileHistory, board, crontab, cli] = await Promise.all([
    readHistory(config.claudeDir, { sinceMs: since }),
    sessionsBoard(storage),
    readCrontab(),
    cliVersion(),
  ]);

  // Token 成本会话名解析:看板(含 agents/bg 名)+ web 派发名 + 重命名覆盖;缺失由 usage 层从转录提默认名
  const nameMap = new Map<string, string>();
  for (const d of storage?.allDispatches() ?? []) if (d.name) nameMap.set(d.sessionId, d.name);
  for (const col of Object.values(board.columns)) for (const s of col) nameMap.set(s.sessionId, s.name);
  for (const [id, n] of storage?.sessionNames() ?? []) nameMap.set(id, n);
  const usage = await todayUsage((id) => nameMap.get(id));

  // SDK 派发会话不写 history.jsonl:并入自有 prompt 流水,时间线/统计条/热力图才不会在纯璇玑使用时冻结
  const webPrompts: HistoryEntry[] = (storage?.recentPrompts(since) ?? []).map((p) => ({
    display: p.display,
    timestamp: p.at,
    project: p.cwd,
    sessionId: p.sessionId ?? '',
  }));
  const history = [...fileHistory, ...webPrompts].sort((a, b) => a.timestamp - b.timestamp);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayEntries = history.filter((e) => e.timestamp >= startOfToday.getTime());
  const activeProjects = new Set(todayEntries.map((e) => e.project)).size;

  const heatMap = heatBuckets(history);
  const heat = [...heatMap.entries()]
    .map(([project, days]) => ({
      project: project.split('/').filter(Boolean).pop() ?? project,
      days,
      total: days.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(({ project, days }) => ({ project, days }));

  const timeline = history
    .slice(-40)
    .reverse()
    .map(toTimelineItem);

  return {
    needsAttention: board.columns.blocked,
    running: board.columns.running,
    // 待处置队列 = 验收中列全体(含已看过但没做决定的)。空闲/已完成是处置后的结果,不再催办。
    reviewCandidates: board.columns.review.filter((s) => s.lastOutputAt && !s.readonly),
    strip: {
      todayPrompts: todayEntries.length,
      todayTokensInOut: usage.totalTokens.inOut,
      todayCacheRead: usage.totalTokens.cacheRead,
      todayCostUsd: usage.totalCostUsd,
      activeProjects,
      systemCrons: crontab.length,
      scheduledJobs: countScheduledJobs(storage?.listScheduledJobs() ?? []),
    },
    timeline,
    heat,
    usage,
    caliber: {
      todayPrompts: 'history.jsonl + 璇玑派发流水中今日(本地时区)的 prompt 条数',
      heat: 'history.jsonl + 璇玑派发流水近 7 日按项目 × 日聚合的 prompt 数',
      usage: usage.caliber,
    },
    health: { cli, agentsOk: board.ok },
  };
}

function countScheduledJobs(jobs: { status: string }[]): { normal: number; fused: number; missed: number } {
  let fused = 0;
  let missed = 0;
  let normal = 0;
  for (const j of jobs) {
    if (j.status === 'fused') fused++;
    else if (j.status === 'missed') missed++;
    else if (j.status !== 'canceled') normal++;
  }
  return { normal, fused, missed };
}

function toTimelineItem(e: HistoryEntry) {
  return {
    time: e.timestamp,
    project: e.project.split('/').filter(Boolean).pop() ?? e.project,
    message: e.display.length > 120 ? e.display.slice(0, 120) + '…' : e.display,
  };
}
