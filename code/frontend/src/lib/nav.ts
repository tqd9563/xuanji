/**
 * 视图导航的两份顺序,及各自的唯一用途 —— 混用它们就是 2026-10-16 的 bug:
 *
 *  - NAVS(侧栏顺序):用户眼睛看到的顺序。⌥⌘←/→「在侧栏前后挪一格」必须按它走。
 *  - VIEW_IDS(lib/hooks,数字键顺序):⌘1–9 的映射。新视图一律追加在末尾,
 *    不让既有的数字键肌肉记忆因新增视图而位移;所以它与侧栏顺序**可以不同**。
 *
 * 提示词页插在侧栏「经验」之后却追加在 VIEW_IDS 末尾,⌥⌘→ 按 VIEW_IDS 走就从「经验」
 * 直接跳到了「定时」,侧栏按钮的「⌘N」提示也按侧栏下标拼,其后每一项都错位一格。
 */
import { VIEW_IDS, type ViewId } from './hooks';

/** 侧栏导航(顺序即显示顺序) */
export const NAVS: { id: ViewId; label: string; icon: string }[] = [
  { id: 'dashboard', label: '仪表盘', icon: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z' },
  { id: 'projects', label: '项目', icon: 'M3 7l3-4h5l2 3h8v13H3z' },
  { id: 'sessions', label: '会话', icon: 'M4 5h16v11H8l-4 4z' },
  { id: 'dispatch', label: '派发', icon: 'M3 12l18-8-6 18-3-7z' },
  { id: 'skills', label: '技能', icon: 'M12 2l2.6 6.6L21 11l-6.4 2.4L12 20l-2.6-6.6L3 11l6.4-2.4z' },
  { id: 'memory', label: '经验', icon: 'M5 3h11l3 3v15H5zM9 8h7M9 12h7M9 16h4' },
  { id: 'prompts', label: '提示词', icon: 'M5 4v16M10 7h10M10 12h7M10 17h9' },
  { id: 'cron', label: '定时', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5l3 2' },
  { id: 'review', label: '回顾', icon: 'M4 5h16v16H4zM4 9.5h16M8.5 3v4M15.5 3v4M8 14l2.5 2.5L16 12' },
  { id: 'worklog', label: '总结', icon: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5' },
  { id: 'todo', label: '待办', icon: 'M4 6h16M4 12h16M4 18h10M2.5 6l1 1 2-2' },
];

/** ⌥⌘←/→:按侧栏顺序前后挪一格,首尾相接 */
export function stepView(cur: ViewId, dir: 1 | -1): ViewId {
  const order = NAVS.map((n) => n.id);
  const i = order.indexOf(cur);
  return order[(i + dir + order.length) % order.length]!;
}

/** 视图对应的数字键(⌘N / 非输入态直接按 N);只有 VIEW_IDS 前 9 个有,其余 null */
export function digitOf(view: ViewId): number | null {
  const i = VIEW_IDS.indexOf(view);
  return i >= 0 && i < 9 ? i + 1 : null;
}
