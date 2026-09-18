/**
 * 收纳列(空闲 / 已完成)折叠态的展示条数。
 *
 * 档位而非任意数字:这两列的语义是「停车场 / 归档」,用户要的是「少扫几张还是多扫几张」,
 * 给输入框反而逼人猜数字。0 = 全部展开(不折叠),此时 Infinity 让 slice / 差值计算
 * 自然退化成「没有更早的」,调用方不必分支。
 */
import type { LocalPrefs } from '@/lib/prefs';

/** 可选档位;0 = 全部 */
export const STOW_OPTS = [3, 5, 10, 0] as const;
export type StowRecent = (typeof STOW_OPTS)[number];

export const stowLabel = (v: StowRecent) => (v === 0 ? '全部' : String(v));

/** 折叠态该显示多少张;`'done'` 与其余(空闲)各读一项偏好 */
export function recentOf(key: 'idle' | 'done' | string, p: Pick<LocalPrefs, 'stowIdle' | 'stowDone'>): number {
  const v = key === 'done' ? p.stowDone : p.stowIdle;
  return v === 0 ? Infinity : v;
}
