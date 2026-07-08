/**
 * Token 用量/成本聚合。
 * 口径:cost = input×单价 + cache_creation×1.25×单价 + cache_read×0.1×单价 + output×单价;
 * 按 assistant 事件的 message.usage 聚合(message.id 去重),牌价见 PRICING(USD / MTok)。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { extractUsage, type RawUsageRecord } from '../adapters/claude-dir.js';
import type { ModelUsage, ProjectUsage, SessionUsage } from '../types.js';

/** USD per MTok: [input, output]。cache 系数固定:write 1.25×in, read 0.1×in */
const PRICING: Record<string, [number, number]> = {
  fable: [5, 25],
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5],
};

export function priceOf(model: string): [number, number] {
  const m = model.toLowerCase();
  for (const [key, p] of Object.entries(PRICING)) if (m.includes(key)) return p;
  return PRICING.sonnet!;
}

export function costUsd(r: RawUsageRecord): number {
  const [inP, outP] = priceOf(r.model);
  return (
    (r.input * inP + r.cacheCreation * inP * 1.25 + r.cacheRead * inP * 0.1 + r.output * outP) / 1e6
  );
}

/** 模型全名 → 短名(fable/opus/sonnet/haiku),用于堆叠分段 */
export function shortModel(model: string): string {
  const m = model.toLowerCase();
  for (const key of Object.keys(PRICING)) if (m.includes(key)) return key;
  return model;
}

export function aggregateByModel(records: RawUsageRecord[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const r of records) {
    const key = shortModel(r.model);
    let m = map.get(key);
    if (!m) {
      map.set(
        key,
        (m = {
          model: key,
          inputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        }),
      );
    }
    m.inputTokens += r.input;
    m.cacheCreationTokens += r.cacheCreation;
    m.cacheReadTokens += r.cacheRead;
    m.outputTokens += r.output;
    m.costUsd += costUsd(r);
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export interface UsageReport {
  projects: ProjectUsage[];
  totalCostUsd: number;
  totalTokens: { inOut: number; cacheRead: number };
  caliber: string;
  computedAt: number;
}

let cache: { at: number; report: UsageReport } | null = null;
const CACHE_MS = 60_000;

/** 今日用量:扫描 mtime 在今日零点之后的 session jsonl */
export async function todayUsage(titleOf?: (sessionId: string) => string | undefined): Promise<UsageReport> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.report;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const since = startOfToday.getTime();

  const root = path.join(config.claudeDir, 'projects');
  const dirs = await fsp.readdir(root).catch(() => [] as string[]);
  const projects: ProjectUsage[] = [];
  let totalCostUsd = 0;
  let inOut = 0;
  let cacheRead = 0;

  for (const d of dirs) {
    if (config.projectNoisePatterns.some((re) => re.test(d))) continue;
    const dir = path.join(root, d);
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    const sessions: SessionUsage[] = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.mtimeMs < since) continue;
      const records = await extractUsage(full);
      if (!records.length) continue;
      const byModel = aggregateByModel(records);
      const total = byModel.reduce((s, m) => s + m.costUsd, 0);
      const sessionId = path.basename(f, '.jsonl');
      sessions.push({ sessionId, title: titleOf?.(sessionId) ?? sessionId.slice(0, 8), byModel, totalCostUsd: total });
    }
    if (!sessions.length) continue;
    sessions.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
    const all = sessions.flatMap((s) => s.byModel);
    const byModel = mergeModelUsage(all);
    const total = byModel.reduce((s, m) => s + m.costUsd, 0);
    totalCostUsd += total;
    for (const m of byModel) {
      inOut += m.inputTokens + m.outputTokens + m.cacheCreationTokens;
      cacheRead += m.cacheReadTokens;
    }
    projects.push({
      project: d.split('-').filter(Boolean).pop() ?? d,
      byModel,
      totalCostUsd: total,
      sessions,
    });
  }
  projects.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  const report: UsageReport = {
    projects,
    totalCostUsd,
    totalTokens: { inOut, cacheRead },
    caliber:
      '今日(本地时区)有活动的 session jsonl,assistant usage 按 message.id 去重;cost = in×P + cacheWrite×1.25P + cacheRead×0.1P + out×P(牌价常量,USD)',
    computedAt: Date.now(),
  };
  cache = { at: Date.now(), report };
  return report;
}

function mergeModelUsage(list: ModelUsage[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const m of list) {
    const prev = map.get(m.model);
    if (!prev) map.set(m.model, { ...m });
    else {
      prev.inputTokens += m.inputTokens;
      prev.cacheCreationTokens += m.cacheCreationTokens;
      prev.cacheReadTokens += m.cacheReadTokens;
      prev.outputTokens += m.outputTokens;
      prev.costUsd += m.costUsd;
    }
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export function invalidateUsageCache() {
  cache = null;
}
