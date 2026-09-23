import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@/api/types';
import { canDrag, dropAction } from './board-drop';

const card = (p: Partial<AgentSession> = {}) => ({ sessionId: 'x', ...p }) as AgentSession;

describe('dropAction', () => {
  it('向右:验收中/空闲 → 已完成归档,验收中 → 空闲挂起', () => {
    expect(dropAction(card(), 'review', 'done')).toBe('archive');
    expect(dropAction(card(), 'idle', 'done')).toBe('archive');
    expect(dropAction(card(), 'review', 'idle')).toBe('suspend');
  });
  it('向左:已归档卡拖到验收中或空闲 = 撤销归档', () => {
    expect(dropAction(card({ archived: true }), 'done', 'review')).toBe('unarchive');
    expect(dropAction(card({ archived: true }), 'done', 'idle')).toBe('unarchive');
  });
  it('向左:已挂起卡拖到验收中 = 撤销挂起', () => {
    expect(dropAction(card({ suspended: true }), 'idle', 'review')).toBe('unsuspend');
  });
  it('自然推导的已完成/空闲不接受向左', () => {
    expect(dropAction(card(), 'done', 'review')).toBeNull();
    expect(dropAction(card(), 'done', 'idle')).toBeNull();
    expect(dropAction(card(), 'idle', 'review')).toBeNull();
    expect(canDrag(card(), 'done')).toBe(false);
  });
  it('原列落下与运行中卡不动', () => {
    expect(dropAction(card({ suspended: true }), 'idle', 'idle')).toBeNull();
    expect(canDrag(card(), 'running')).toBe(false);
  });
});
