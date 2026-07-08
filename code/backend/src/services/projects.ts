import { config } from '../config.js';
import { scanProjectDirs } from '../adapters/claude-dir.js';
import { gitStatus } from '../adapters/git.js';
import type { HistoryEntry, Project } from '../types.js';

export interface ProjectsResult {
  projects: Project[];
  filteredNoise: number;
  filteredMissing: number;
}

const DAY = 86_400_000;

/** 近 7 日热力桶:[6天前..今天],按本地时区日界 */
export function heatBuckets(entries: HistoryEntry[], now = Date.now()): Map<string, number[]> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  const map = new Map<string, number[]>();
  for (const e of entries) {
    const offset = Math.floor((e.timestamp - todayStart) / DAY);
    if (offset > 0 || offset < -6) continue;
    const idx = offset + 6;
    let arr = map.get(e.project);
    if (!arr) map.set(e.project, (arr = [0, 0, 0, 0, 0, 0, 0]));
    arr[idx] = (arr[idx] ?? 0) + 1;
  }
  return map;
}

export async function listProjects(history: HistoryEntry[]): Promise<ProjectsResult> {
  const raw = await scanProjectDirs(config.claudeDir);
  const lastActive = new Map<string, number>();
  for (const e of history) {
    const prev = lastActive.get(e.project);
    if (!prev || e.timestamp > prev) lastActive.set(e.project, e.timestamp);
  }
  const heat = heatBuckets(history);

  let filteredNoise = 0;
  let filteredMissing = 0;
  const kept = raw.filter((p) => {
    if (config.projectNoisePatterns.some((re) => re.test(p.path) || re.test(p.encodedDir))) {
      filteredNoise++;
      return false;
    }
    if (!p.exists) {
      filteredMissing++;
      return false;
    }
    return true;
  });

  const projects: Project[] = await Promise.all(
    kept.map(async (p) => ({
      name: p.path.split('/').filter(Boolean).pop() ?? p.path,
      path: p.path,
      encodedDir: p.encodedDir,
      sessionCount: p.sessionCount,
      memoryCount: p.memoryCount,
      lastActiveAt: lastActive.get(p.path) ?? null,
      heat: heat.get(p.path) ?? [0, 0, 0, 0, 0, 0, 0],
      git: await gitStatus(p.path),
    })),
  );
  projects.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  return { projects, filteredNoise, filteredMissing };
}
