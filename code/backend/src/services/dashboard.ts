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
  const [history, board, usage, crontab, cli] = await Promise.all([
    readHistory(config.claudeDir, { sinceMs: since }),
    sessionsBoard(storage),
    todayUsage(),
    readCrontab(),
    cliVersion(),
  ]);

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
    reviewCandidates: [...board.columns.idle, ...board.columns.done].filter((s) => s.lastOutputAt && !s.readonly),
    strip: {
      todayPrompts: todayEntries.length,
      todayTokensInOut: usage.totalTokens.inOut,
      todayCacheRead: usage.totalTokens.cacheRead,
      todayCostUsd: usage.totalCostUsd,
      activeProjects,
      systemCrons: crontab.length,
    },
    timeline,
    heat,
    usage,
    caliber: {
      todayPrompts: 'history.jsonl 中今日(本地时区)的 prompt 条数',
      heat: 'history.jsonl 近 7 日按项目 × 日聚合的 prompt 数',
      usage: usage.caliber,
    },
    health: { cli, agentsOk: board.ok },
  };
}

function toTimelineItem(e: HistoryEntry) {
  return {
    time: e.timestamp,
    project: e.project.split('/').filter(Boolean).pop() ?? e.project,
    message: e.display.length > 120 ? e.display.slice(0, 120) + '…' : e.display,
  };
}
