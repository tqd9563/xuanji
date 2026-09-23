import type { AgentSession, SessionState } from '@/api/types';

/** 看板上可接住卡片的三列 */
export type DropCol = 'review' | 'idle' | 'done';
/** 一次落下对应的后端动作;null = 此落点不接这张卡 */
export type DropAction = 'archive' | 'suspend' | 'unarchive' | 'unsuspend' | null;

/**
 * 卡片从 from 列拖到 to 列时该做什么。
 * 向右 = 处置(挂起/归档);向左 = 撤销手动处置,只对「被手动放过去」的卡成立——
 * 自然推导出的空闲/已完成没有可撤销的东西,落点不亮。
 * 已归档卡拖到验收中或空闲都是撤销归档:卡回到它推导态所在的列,不一定停在落点。
 */
export function dropAction(s: AgentSession, from: SessionState, to: DropCol): DropAction {
  if (from === to) return null;
  if (to === 'done') return from === 'review' || from === 'idle' ? 'archive' : null;
  if (from === 'done') return s.archived ? 'unarchive' : null;
  if (to === 'idle') return from === 'review' ? 'suspend' : null;
  // to === 'review'
  return from === 'idle' && s.suspended ? 'unsuspend' : null;
}

/** 这张卡能不能拿起来:至少有一个落点接它 */
export function canDrag(s: AgentSession, from: SessionState): boolean {
  return (['review', 'idle', 'done'] as const).some((to) => dropAction(s, from, to) !== null);
}
