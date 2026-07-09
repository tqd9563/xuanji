import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 项目分类色:DESIGN.md「等明度分类规则」——oklch(0.78 0.12 H) 只转色相。
 *  色环序号 = 项目名 FNV-1a 哈希:同名永远同色,跨视图/刷新/端一致,零状态
 *  (取代按首次渲染顺序分配的旧实现——那会随数据顺序变化导致同项目变色)。 */
const PROJ_HUES = [115, 245, 300, 195, 345, 55, 160, 270];
export function projHue(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PROJ_HUES[(h >>> 0) % PROJ_HUES.length]!;
}
export const projColor = (name: string) => `oklch(0.78 0.12 ${projHue(name)})`;
export const projBg = (name: string) => `oklch(0.78 0.12 ${projHue(name)} / 0.16)`;

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

export const fmtCost = (usd: number) => '$' + usd.toFixed(2);

export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
