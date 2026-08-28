/**
 * Token 用量/成本聚合。
 * 口径:cost = input×单价 + cache_creation×1.25×单价 + cache_read×0.1×单价 + output×单价;
 * 按 assistant 事件的 message.usage 聚合(message.id 去重),牌价见 PRICING(USD / MTok)。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { extractSessionTitle, extractUsage, type RawUsageRecord } from '../adapters/claude-dir.js';
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

/** 用量窗口。today = 本地时区当日零点起;7d = 含今日在内的近 7 个自然日(与热力图同窗口) */
export type UsageRange = 'today' | '7d';

export const USAGE_RANGES: UsageRange[] = ['today', '7d'];
export const isUsageRange = (v: unknown): v is UsageRange => USAGE_RANGES.includes(v as UsageRange);

/** 窗口起点(本地时区日界)。7d 往前推 6 天,加上今天正好 7 个自然日 */
export function rangeStart(range: UsageRange, now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (range === '7d') d.setDate(d.getDate() - 6);
  return d.getTime();
}

export interface UsageReport {
  range: UsageRange;
  since: number;
  projects: ProjectUsage[];
  totalCostUsd: number;
  totalTokens: { inOut: number; cacheRead: number };
  /**
   * 被 projectNoisePatterns 过滤掉的目录(multica workspaces)的汇总。
   * 只给总量不给明细:它是「非开发」对照组,进项目条形图会碾压真实开发项目的分辨率。
   */
  noise: { costUsd: number; tokens: { inOut: number; cacheRead: number } };
  caliber: string;
  computedAt: number;
}

const cache = new Map<UsageRange, { at: number; report: UsageReport }>();
const CACHE_MS = 60_000;

const RANGE_LABEL: Record<UsageRange, string> = { today: '今日', '7d': '近 7 日' };

/** 用量报表:扫描 mtime 落在窗口内的 session jsonl,再按记录时间戳二次过滤 */
export async function usageReport(
  range: UsageRange = 'today',
  titleOf?: (sessionId: string) => string | undefined,
): Promise<UsageReport> {
  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.report;

  const since = rangeStart(range);

  const root = path.join(config.claudeDir, 'projects');
  const dirs = await fsp.readdir(root).catch(() => [] as string[]);
  const projects: ProjectUsage[] = [];
  let totalCostUsd = 0;
  let inOut = 0;
  let cacheRead = 0;
  const noise = { costUsd: 0, tokens: { inOut: 0, cacheRead: 0 } };

  for (const d of dirs) {
    // 噪音目录不进项目明细,但要单独汇总一份用于「开发 vs multica」对比
    const isNoise = config.projectNoisePatterns.some((re) => re.test(d));
    const dir = path.join(root, d);
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    const sessions: SessionUsage[] = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.mtimeMs < since) continue; // 文件窗口内没动过 → 整体跳过(快速筛)
      const records = await extractUsage(full, since); // 再按记录时间戳过滤,只留窗口内
      if (!records.length) continue;
      const byModel = aggregateByModel(records);
      if (isNoise) {
        // 噪音目录只累加总量:跳过标题提取(多一次读盘)与会话明细
        for (const m of byModel) {
          noise.costUsd += m.costUsd;
          noise.tokens.inOut += m.inputTokens + m.outputTokens + m.cacheCreationTokens;
          noise.tokens.cacheRead += m.cacheReadTokens;
        }
        continue;
      }
      const sessionId = path.basename(f, '.jsonl');
      // 名字优先注册表(重命名/派发/jobs/看板),缺失则从转录提取默认标题,再兜底短 id
      const title = titleOf?.(sessionId) || (await extractSessionTitle(full)) || sessionId.slice(0, 8);
      sessions.push({
        sessionId,
        title,
        byModel,
        totalCostUsd: byModel.reduce((s, m) => s + m.costUsd, 0),
        totalTokens: sumTokens(byModel),
      });
    }
    if (isNoise || !sessions.length) continue;
    sessions.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
    const all = sessions.flatMap((s) => s.byModel);
    const byModel = mergeModelUsage(all);
    const total = byModel.reduce((s, m) => s + m.costUsd, 0);
    const tokens = sumTokens(byModel);
    totalCostUsd += total;
    inOut += tokens.inOut;
    cacheRead += tokens.cacheRead;
    projects.push({
      dir: d,
      project: d.split('-').filter(Boolean).pop() ?? d,
      byModel,
      totalCostUsd: total,
      totalTokens: tokens,
      sessions,
    });
  }
  disambiguate(projects);
  projects.sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  const report: UsageReport = {
    range,
    since,
    projects,
    totalCostUsd,
    totalTokens: { inOut, cacheRead },
    noise,
    caliber:
      `${RANGE_LABEL[range]}(本地时区)有活动的 session jsonl,assistant usage 按 message.id 去重;` +
      'cost = in×P + cacheWrite×1.25P + cacheRead×0.1P + out×P(牌价常量,USD);' +
      'token 量 = in + out + cacheWrite(不含 cacheRead,与统计条同口径);' +
      'multica workspaces 与 narrate(claude -p)不进项目明细,只计入对比总量(口径同 cost_report.py 的 Multica+Narrate)',
    computedAt: Date.now(),
  };
  cache.set(range, { at: Date.now(), report });
  return report;
}

/** 今日用量(仪表盘首屏口径) */
export const todayUsage = (titleOf?: (sessionId: string) => string | undefined) => usageReport('today', titleOf);

/**
 * 显示名去重:目录末段重名的项目往前多带一段(`skills` → `yuiko-skills` / `antifraud-skills`)。
 * 近一周窗口项目数是今日的两倍多,末段撞名是常态——不消歧则条形图出现两行同名、用户分不清谁是谁。
 * 注意编码目录名里 '-' 既是分隔符也可能是路径本身的连字符,无法反解,故只做「多带一段」的最小消歧。
 */
function disambiguate(projects: ProjectUsage[]) {
  const byName = new Map<string, ProjectUsage[]>();
  for (const p of projects) {
    const list = byName.get(p.project);
    if (list) list.push(p);
    else byName.set(p.project, [p]);
  }
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    for (let take = 2; take <= 4; take++) {
      for (const p of group) p.project = p.dir.split('-').filter(Boolean).slice(-take).join('-');
      if (new Set(group.map((p) => p.project)).size === group.length) break;
    }
    // 仍然撞名(极罕见):退回完整编码目录名,保证唯一
    if (new Set(group.map((p) => p.project)).size !== group.length) {
      for (const p of group) p.project = p.dir;
    }
  }
}

/** token 量口径:inOut 不含 cacheRead——cacheRead 量级压倒性大且只值 0.1×单价,混进来会让条形图只反映缓存命中 */
function sumTokens(list: ModelUsage[]): { inOut: number; cacheRead: number } {
  let inOut = 0;
  let cacheRead = 0;
  for (const m of list) {
    inOut += m.inputTokens + m.outputTokens + m.cacheCreationTokens;
    cacheRead += m.cacheReadTokens;
  }
  return { inOut, cacheRead };
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
  cache.clear();
}
