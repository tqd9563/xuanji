import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ModelUsage } from '@/api/types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 项目分类色:DESIGN.md「等明度分类规则」——oklch(0.78 0.12 H) 只转色相。
 *  色环 11 个色相按最大间隔交错排列,避开红(错误)/琥珀(等待)语义区。
 *  序号优先取后端调色板(/api/palette,首次出现顺序 SQLite 固定 → 前 11 个项目
 *  保证互不撞色且全端一致);调色板未加载或未知名字时退化为 FNV-1a 哈希。 */
const PROJ_HUES = [115, 265, 190, 340, 55, 215, 140, 290, 165, 315, 240];
let paletteIdx: Record<string, number> = {};
export function setPalette(map: Record<string, number>) {
  paletteIdx = map;
}
export function projHue(name: string): number {
  const idx = paletteIdx[name];
  if (idx !== undefined) return PROJ_HUES[idx % PROJ_HUES.length]!;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PROJ_HUES[(h >>> 0) % PROJ_HUES.length]!;
}
/** 项目在调色板里的序号(首次出现顺序,后端 SQLite 固定);未收录的返回 +∞,排序时垫底。
 *  给需要稳定项目顺序的界面用(会话页项目过滤 chip),与分类色同源保证位置与色序一致。 */
export const projOrder = (name: string) => paletteIdx[name] ?? Number.POSITIVE_INFINITY;
export const projColor = (name: string) => `oklch(0.78 0.12 ${projHue(name)})`;
export const projBg = (name: string) => `oklch(0.78 0.12 ${projHue(name)} / 0.16)`;

// ---------- 已读表(「待验收」判定,per-viewer 状态存 localStorage) ----------

const SEEN_KEY = 'xuanji-seen';
const SEEN_BASELINE_KEY = 'xuanji-seen-baseline';

function seenMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** 首次使用时以当下为基线:历史存量会话不集体点亮「待验收」 */
function seenBaseline(): number {
  let b = Number(localStorage.getItem(SEEN_BASELINE_KEY));
  if (!b) {
    b = Date.now();
    localStorage.setItem(SEEN_BASELINE_KEY, String(b));
  }
  return b;
}

export function markSeen(sessionId: string) {
  const m = seenMap();
  m[sessionId] = Date.now();
  localStorage.setItem(SEEN_KEY, JSON.stringify(m));
}

/**
 * 待验收 = 验收中 + 有产出 + 产出晚于「你最后看它的时间」(未看过则晚于基线)。
 *
 * 只对「验收中」生效:催办信号必须单一来源。空闲(含已挂起)与已完成都是你处置过的结果,
 * 再挂催办角标只会自相矛盾——列说「不用管」,角标说「你没看过」。角标在此退化为
 * 验收中列内的强调与排序信号(未读排顶),不再是独立的催办系统。
 * 注意角标与列仍是两件事:看过回放只熄灭角标(卡片留在验收中),显式处置才换列。
 */
export function isUnread(s: { sessionId: string; state: string; readonly: boolean; lastOutputAt?: number }): boolean {
  if (!s.lastOutputAt || s.readonly) return false;
  if (s.state !== 'review') return false;
  return s.lastOutputAt > (seenMap()[s.sessionId] ?? seenBaseline());
}

/** 图表系列色(模型):DESIGN.md chart-1/2/3 */
export const MODEL_COLOR: Record<string, string> = {
  fable: 'var(--chart-1)',
  opus: 'var(--chart-2)',
  sonnet: 'var(--chart-3)',
  haiku: 'oklch(0.66 0.06 160)',
};
export const modelColor = (m: string) => MODEL_COLOR[m] ?? 'var(--muted)';

export function timeAgo(ts: number | null): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d === 2) return '前天';
  if (d < 7) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 会话消息时间戳:ms epoch 或 session jsonl 的 ISO 串 → HH:MM;无时间(如 tool 事件)返回 null */
export function msgClock(ts: number | string | null | undefined): string | null {
  if (ts == null) return null;
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return clock(ms);
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 消息时间归一为本地日历日的序号(非 UTC:跨天要按用户所在时区判定) */
function dayIndex(ts: number | string): number | null {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** 日期分隔线文案:「2026-08-19 · 周三」 */
export function dayLabel(ts: number | string): string {
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} · ${WEEKDAY[d.getDay()]}`;
}

/**
 * 跨天分隔线判定:返回本条消息之前应插入的日期文案,不需要则 null。
 * 会话首条带时间的消息之前总是插一条(交代这段对话发生在哪天);
 * 之后只在与上一条带时间的消息跨自然日时插。无时间的事件(工具卡等)不参与,
 * 故调用方需自行维护「上一条有时间的消息」的游标而非简单取前一项。
 */
export function daySeparator(prev: number | string | null | undefined, cur: number | string | null | undefined): string | null {
  if (cur == null) return null;
  const curDay = dayIndex(cur);
  if (curDay === null) return null;
  if (prev == null) return dayLabel(cur);
  const prevDay = dayIndex(prev);
  if (prevDay === null) return dayLabel(cur);
  return prevDay === curDay ? null : dayLabel(cur);
}

export const fmtCost = (usd: number) => '$' + usd.toFixed(2);

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; // 近一周量级会上到十亿档,B 位保两位小数才分得出高低
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/**
 * 「⚑ 任务总结」是否可用。判据是**有没有可收口的上下文**,不是「SDK 会话是否活着」——
 * 后端重启后 attach 失败会把 started 清零,但从看板/`/resume` 续接进来的会话
 * (resumeInfo 已就位、历史已装载)照样能收口:发送路径带 `resume: sessionId`,
 * SDK 会恢复完整上下文,skill 拿得到真实转录。
 * 曾经只看 started,导致「重启后续接一个有 37 条历史的会话」按钮是灰的(2026-07-31 修复)。
 */
export function canWrapup(started: boolean, hasResumeTarget: boolean): boolean {
  return started || hasResumeTarget;
}

/** token 四分量:inOut 口径把三类计费分量揉成一个数,这里拆开看结构 */
export interface TokenComp {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** cacheRead 计费单价是 input 的 0.1 倍(与 backend/services/usage.ts 的 costUsd 同源) */
export const CACHE_READ_WEIGHT = 0.1;

export function sumComp(list: ModelUsage[]): TokenComp {
  const c: TokenComp = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const m of list) {
    c.input += m.inputTokens;
    c.output += m.outputTokens;
    c.cacheWrite += m.cacheCreationTokens;
    c.cacheRead += m.cacheReadTokens;
  }
  return c;
}

/** 完整日期时间(悬停提示用);无法解析返回 null,由调用方决定省略 */
export function fullTime(ts: number | string | null | undefined): string | null {
  if (ts == null) return null;
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString('zh-CN');
}

/**
 * PR/MR 卡片的文案:编号前缀随平台走(GitLab 用 !,GitHub 用 #),
 * 元信息按「已创建 时刻 · 更新 N 次」组织,缺时间就只留有的那半截。
 */
export function prCardText(pr: {
  platform: 'gitlab' | 'github' | 'other';
  number?: number;
  updates: number;
  ts?: number | string;
}): { label: string; meta: string } {
  const created = msgClock(pr.ts);
  const label = pr.number != null ? `${pr.platform === 'gitlab' ? '!' : '#'}${pr.number}` : '链接';
  const meta = [created && `已创建 ${created}`, pr.updates > 0 && `更新 ${pr.updates} 次`].filter(Boolean).join(' · ');
  return { label, meta };
}
